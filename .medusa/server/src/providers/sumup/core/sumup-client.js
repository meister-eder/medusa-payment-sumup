"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SumUpClient = void 0;
const types_1 = require("../types");
const SUMUP_API_BASE = "https://api.sumup.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
// Use zero-delay backoff in tests so the suite stays fast.
const BASE_BACKOFF_MS = process.env.NODE_ENV === "test" ? 0 : 300;
// Fields that must never appear in logged/thrown error messages.
const SENSITIVE_FIELDS = new Set([
    "card",
    "cvv",
    "pan",
    "pan_fingerprint",
    "token",
    "number",
    "secret",
]);
/** Recursively drop sensitive keys from a parsed value (objects + arrays). */
function redactValue(value) {
    if (Array.isArray(value))
        return value.map(redactValue);
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            if (SENSITIVE_FIELDS.has(key.toLowerCase()))
                continue;
            out[key] = redactValue(val);
        }
        return out;
    }
    return value;
}
/** Strips sensitive keys from a JSON error body before it appears in error messages. */
function redactErrorBody(text) {
    try {
        const redacted = redactValue(JSON.parse(text));
        const serialized = JSON.stringify(redacted);
        // Bound the final size regardless of shape.
        return serialized.length > 1000
            ? `${serialized.slice(0, 1000)}…`
            : serialized;
    }
    catch {
        // Non-JSON body (e.g. HTML gateway error) — truncate to avoid noise.
        return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    }
}
/** Classify an HTTP status code into a SumUpErrorType. */
function classifyStatus(status) {
    if (status === 401 || status === 403)
        return "auth";
    if (status === 404)
        return "not_found";
    if (status === 409)
        return "conflict";
    if (status === 429)
        return "rate_limit";
    if (status >= 500)
        return "server";
    // All other 4xx (400, 402, 405, 410, 422, …) are client errors: retrying
    // won't help, so classify as non-retryable "validation" rather than "server".
    return "validation";
}
/** Async sleep.  Resolves immediately when ms ≤ 0. */
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Compute how long to wait before the next retry.
 * Respects the `Retry-After` header (seconds) when provided by the server,
 * otherwise uses bounded exponential back-off with ±30 % jitter.
 */
function backoffMs(attempt, retryAfterSec) {
    if (retryAfterSec !== undefined && !Number.isNaN(retryAfterSec)) {
        return Math.min(retryAfterSec * 1_000, 60_000);
    }
    const base = BASE_BACKOFF_MS * 2 ** attempt;
    const jitter = Math.random() * base * 0.3;
    return Math.min(base + jitter, 10_000);
}
class SumUpClient {
    constructor(options) {
        this.headers = {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
        };
    }
    /**
     * Central request dispatcher.  Handles timeouts, error classification,
     * and retries (with back-off) for transient failures (5xx, rate-limit,
     * network errors, and timeouts).
     */
    async request(url, init, attempt = 0) {
        let res;
        // Only idempotent methods may be auto-retried. Retrying a POST
        // (createCheckout, refundTransaction) after a timeout / 5xx risks a
        // DUPLICATE side effect — e.g. a second refund — because the first
        // request may have been processed by SumUp before the response was
        // lost. GET/DELETE can be safely replayed.
        const method = (init.method ?? "GET").toUpperCase();
        const isIdempotent = method === "GET" || method === "DELETE";
        // ── Network / timeout ──────────────────────────────────────────
        try {
            res = await fetch(url, {
                ...init,
                headers: this.headers,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        }
        catch (err) {
            const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
            const type = isTimeout ? "timeout" : "network";
            if (isIdempotent && attempt < MAX_RETRIES) {
                await sleep(backoffMs(attempt));
                return this.request(url, init, attempt + 1);
            }
            throw new types_1.SumUpClientError(isTimeout
                ? `SumUp request timed out after ${REQUEST_TIMEOUT_MS}ms`
                : `SumUp network error: ${err?.message ?? "unknown"}`, type);
        }
        // ── Success ────────────────────────────────────────────────────
        if (res.ok) {
            if (res.status === 204)
                return undefined;
            // Some success responses (e.g. DELETE/refund) carry an empty or
            // non-JSON body. Reading text first avoids res.json() throwing a raw
            // SyntaxError that would escape our typed-error contract.
            const text = await res.text().catch(() => "");
            if (text.trim() === "")
                return undefined;
            try {
                return JSON.parse(text);
            }
            catch {
                throw new types_1.SumUpClientError(`SumUp returned a non-JSON success body (${res.status})`, "server", res.status);
            }
        }
        // ── Error response ─────────────────────────────────────────────
        const bodyText = await res.text().catch(() => "");
        const type = classifyStatus(res.status);
        const isRetryable = type === "rate_limit" || type === "server";
        if (isIdempotent && isRetryable && attempt < MAX_RETRIES) {
            const retryAfterHeader = res.headers.get("Retry-After");
            const retryAfterSec = retryAfterHeader != null
                ? parseInt(retryAfterHeader, 10)
                : undefined;
            await sleep(backoffMs(attempt, retryAfterSec));
            return this.request(url, init, attempt + 1);
        }
        throw new types_1.SumUpClientError(`SumUp API error (${res.status}): ${redactErrorBody(bodyText)}`, type, res.status);
    }
    async createCheckout(params) {
        return this.request(`${SUMUP_API_BASE}/v0.1/checkouts`, {
            method: "POST",
            body: JSON.stringify(params),
        });
    }
    async getCheckout(checkoutId) {
        return this.request(`${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { method: "GET" });
    }
    async deactivateCheckout(checkoutId) {
        try {
            await this.request(`${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { method: "DELETE" });
        }
        catch (err) {
            // A 404 means the checkout is already gone — treat as success.
            if (err instanceof types_1.SumUpClientError && err.type === "not_found")
                return;
            throw err;
        }
    }
    async refundTransaction(transactionId, amount) {
        const body = {};
        if (amount !== undefined)
            body.amount = amount;
        return this.request(`${SUMUP_API_BASE}/v0.1/me/refund/${encodeURIComponent(transactionId)}`, { method: "POST", body: JSON.stringify(body) });
    }
}
exports.SumUpClient = SumUpClient;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VtdXAtY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Byb3ZpZGVycy9zdW11cC9jb3JlL3N1bXVwLWNsaWVudC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFNQSxvQ0FBNEM7QUFFNUMsTUFBTSxjQUFjLEdBQUcsdUJBQXVCLENBQUM7QUFDL0MsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUM7QUFDbEMsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0FBRXRCLDJEQUEyRDtBQUMzRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBRWxFLGlFQUFpRTtBQUNqRSxNQUFNLGdCQUFnQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQy9CLE1BQU07SUFDTixLQUFLO0lBQ0wsS0FBSztJQUNMLGlCQUFpQjtJQUNqQixPQUFPO0lBQ1AsUUFBUTtJQUNSLFFBQVE7Q0FDVCxDQUFDLENBQUM7QUFFSCw4RUFBOEU7QUFDOUUsU0FBUyxXQUFXLENBQUMsS0FBYztJQUNqQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ3hELElBQUksS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ3ZDLE1BQU0sR0FBRyxHQUE0QixFQUFFLENBQUM7UUFDeEMsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBZ0MsQ0FBQyxFQUFFLENBQUM7WUFDMUUsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUFFLFNBQVM7WUFDdEQsR0FBRyxDQUFDLEdBQUcs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