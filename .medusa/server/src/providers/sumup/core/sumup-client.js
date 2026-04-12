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
/** Strips sensitive keys from a JSON error body before it appears in error messages. */
function redactErrorBody(text) {
    try {
        const obj = JSON.parse(text);
        for (const key of SENSITIVE_FIELDS) {
            delete obj[key];
        }
        return JSON.stringify(obj);
    }
    catch {
        // Non-JSON body (e.g. HTML gateway error) — truncate to avoid noise.
        return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    }
}
/** Classify an HTTP status code into a SumUpErrorType. */
function classifyStatus(status) {
    if (status === 400 || status === 422)
        return "validation";
    if (status === 401 || status === 403)
        return "auth";
    if (status === 404)
        return "not_found";
    if (status === 409)
        return "conflict";
    if (status === 429)
        return "rate_limit";
    return "server"; // 5xx and any other non-OK code
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
            if (attempt < MAX_RETRIES) {
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
            return (await res.json());
        }
        // ── Error response ─────────────────────────────────────────────
        const bodyText = await res.text().catch(() => "");
        const type = classifyStatus(res.status);
        const isRetryable = type === "rate_limit" || type === "server";
        if (isRetryable && attempt < MAX_RETRIES) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VtdXAtY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Byb3ZpZGVycy9zdW11cC9jb3JlL3N1bXVwLWNsaWVudC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFNQSxvQ0FBNEM7QUFFNUMsTUFBTSxjQUFjLEdBQUcsdUJBQXVCLENBQUM7QUFDL0MsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUM7QUFDbEMsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0FBRXRCLDJEQUEyRDtBQUMzRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBRWxFLGlFQUFpRTtBQUNqRSxNQUFNLGdCQUFnQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQy9CLE1BQU07SUFDTixLQUFLO0lBQ0wsS0FBSztJQUNMLGlCQUFpQjtJQUNqQixPQUFPO0lBQ1AsUUFBUTtJQUNSLFFBQVE7Q0FDVCxDQUFDLENBQUM7QUFFSCx3RkFBd0Y7QUFDeEYsU0FBUyxlQUFlLENBQUMsSUFBWTtJQUNuQyxJQUFJLENBQUM7UUFDSCxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBNEIsQ0FBQztRQUN4RCxLQUFLLE1BQU0sR0FBRyxJQUFJLGdCQUFnQixFQUFFLENBQUM7WUFDbkMsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbEIsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AscUVBQXFFO1FBQ3JFLE9BQU8sSUFBSSxDQUFDLE1BQU0sR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQzdELENBQUM7QUFDSCxDQUFDO0FBRUQsMERBQTBEO0FBQzFELFNBQVMsY0FBYyxDQUFDLE1BQWM7SUFDcEMsSUFBSSxNQUFNLEtBQUssR0FBRyxJQUFJLE1BQU0sS0FBSyxHQUFHO1FBQUUsT0FBTyxZQUFZLENBQUM7SUFDMUQsSUFBSSxNQUFNLEtBQUssR0FBRyxJQUFJLE1BQU0sS0FBSyxHQUFHO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDcEQsSUFBSSxNQUFNLEtBQUssR0FBRztRQUFFLE9BQU8sV0FBVyxDQUFDO0lBQ3ZDLElBQUksTUFBTSxLQUFLLEdBQUc7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUN0QyxJQUFJLE1BQU0sS0FBSyxHQUFHO1FBQUUsT0FBTyxZQUFZLENBQUM7SUFDeEMsT0FBTyxRQUFRLENBQUMsQ0FBQyxnQ0FBZ0M7QUFDbkQsQ0FBQztBQUVELHNEQUFzRDtBQUN0RCxTQUFTLEtBQUssQ0FBQyxFQUFVO0lBQ3ZCLElBQUksRUFBRSxJQUFJLENBQUM7UUFBRSxPQUFPLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztJQUN0QyxPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDM0QsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxTQUFTLFNBQVMsQ0FBQyxPQUFlLEVBQUUsYUFBc0I7SUFDeEQsSUFBSSxhQUFhLEtBQUssU0FBUyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDO1FBQ2hFLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxhQUFhLEdBQUcsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFDRCxNQUFNLElBQUksR0FBRyxlQUFlLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQztJQUM1QyxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLEdBQUcsSUFBSSxHQUFHLEdBQUcsQ0FBQztJQUMxQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxHQUFHLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztBQUN6QyxDQUFDO0FBRUQsTUFBYSxXQUFXO0lBR3RCLFlBQVksT0FBNkI7UUFDdkMsSUFBSSxDQUFDLE9BQU8sR0FBRztZQUNiLGFBQWEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxNQUFNLEVBQUU7WUFDekMsY0FBYyxFQUFFLGtCQUFrQjtTQUNuQyxDQUFDO0lBQ0osQ0FBQztJQUVEOzs7O09BSUc7SUFDSyxLQUFLLENBQUMsT0FBTyxDQUNuQixHQUFXLEVBQ1gsSUFBNkMsRUFDN0MsT0FBTyxHQUFHLENBQUM7UUFFWCxJQUFJLEdBQWEsQ0FBQztRQUVsQixrRUFBa0U7UUFDbEUsSUFBSSxDQUFDO1lBQ0gsR0FBRyxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDckIsR0FBRyxJQUFJO2dCQUNQLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztnQkFDckIsTUFBTSxFQUFFLFdBQVcsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7YUFDaEQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUFDLE9BQU8sR0FBUSxFQUFFLENBQUM7WUFDbEIsTUFBTSxTQUFTLEdBQ2IsR0FBRyxFQUFFLElBQUksS0FBSyxjQUFjLElBQUksR0FBRyxFQUFFLElBQUksS0FBSyxZQUFZLENBQUM7WUFDN0QsTUFBTSxJQUFJLEdBQW1CLFNBQVMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7WUFFL0QsSUFBSSxPQUFPLEdBQUcsV0FBVyxFQUFFLENBQUM7Z0JBQzFCLE1BQU0sS0FBSyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2dCQUNoQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUksR0FBRyxFQUFFLElBQUksRUFBRSxPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDakQsQ0FBQztZQUVELE1BQU0sSUFBSSx3QkFBZ0IsQ0FDeEIsU0FBUztnQkFDUCxDQUFDLENBQUMsaUNBQWlDLGtCQUFrQixJQUFJO2dCQUN6RCxDQUFDLENBQUMsd0JBQXdCLEdBQUcsRUFBRSxPQUFPLElBQUksU0FBUyxFQUFFLEVBQ3ZELElBQUksQ0FDTCxDQUFDO1FBQ0osQ0FBQztRQUVELGtFQUFrRTtRQUNsRSxJQUFJLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQztZQUNYLElBQUksR0FBRyxDQUFDLE1BQU0sS0FBSyxHQUFHO2dCQUFFLE9BQU8sU0FBYyxDQUFDO1lBQzlDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBTSxDQUFDO1FBQ2pDLENBQUM7UUFFRCxrRUFBa0U7UUFDbEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2xELE1BQU0sSUFBSSxHQUFHLGNBQWMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEMsTUFBTSxXQUFXLEdBQUcsSUFBSSxLQUFLLFlBQVksSUFBSSxJQUFJLEtBQUssUUFBUSxDQUFDO1FBRS9ELElBQUksV0FBVyxJQUFJLE9BQU8sR0FBRyxXQUFXLEVBQUUsQ0FBQztZQUN6QyxNQUFNLGdCQUFnQixHQUFHLEdBQUcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1lBQ3hELE1BQU0sYUFBYSxHQUNqQixnQkFBZ0IsSUFBSSxJQUFJO2dCQUN0QixDQUFDLENBQUMsUUFBUSxDQUFDLGdCQUFnQixFQUFFLEVBQUUsQ0FBQztnQkFDaEMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUNoQixNQUFNLEtBQUssQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUM7WUFDL0MsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFJLEdBQUcsRUFBRSxJQUFJLEVBQUUsT0FBTyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQ2pELENBQUM7UUFFRCxNQUFNLElBQUksd0JBQWdCLENBQ3hCLG9CQUFvQixHQUFHLENBQUMsTUFBTSxNQUFNLGVBQWUsQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUMvRCxJQUFJLEVBQ0osR0FBRyxDQUFDLE1BQU0sQ0FDWCxDQUFDO0lBQ0osQ0FBQztJQUVELEtBQUssQ0FBQyxjQUFjLENBQUMsTUFBNEI7UUFDL0MsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFnQixHQUFHLGNBQWMsaUJBQWlCLEVBQUU7WUFDckUsTUFBTSxFQUFFLE1BQU07WUFDZCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUM7U0FDN0IsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELEtBQUssQ0FBQyxXQUFXLENBQUMsVUFBa0I7UUFDbEMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUNqQixHQUFHLGNBQWMsbUJBQW1CLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxFQUFFLEVBQ3BFLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxDQUNsQixDQUFDO0lBQ0osQ0FBQztJQUVELEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxVQUFrQjtRQUN6QyxJQUFJLENBQUM7WUFDSCxNQUFNLElBQUksQ0FBQyxPQUFPLENBQ2hCLEdBQUcsY0FBYyxtQkFBbUIsa0JBQWtCLENBQUMsVUFBVSxDQUFDLEVBQUUsRUFDcEUsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLENBQ3JCLENBQUM7UUFDSixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNiLCtEQUErRDtZQUMvRCxJQUFJLEdBQUcsWUFBWSx3QkFBZ0IsSUFBSSxHQUFHLENBQUMsSUFBSSxLQUFLLFdBQVc7Z0JBQUUsT0FBTztZQUN4RSxNQUFNLEdBQUcsQ0FBQztRQUNaLENBQUM7SUFDSCxDQUFDO0lBRUQsS0FBSyxDQUFDLGlCQUFpQixDQUNyQixhQUFxQixFQUNyQixNQUFlO1FBRWYsTUFBTSxJQUFJLEdBQTRCLEVBQUUsQ0FBQztRQUN6QyxJQUFJLE1BQU0sS0FBSyxTQUFTO1lBQUUsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFFL0MsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUNqQixHQUFHLGNBQWMsbUJBQW1CLGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxFQUFFLEVBQ3ZFLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUMvQyxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBbEhELGtDQWtIQyJ9