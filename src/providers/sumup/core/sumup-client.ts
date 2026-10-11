import type {
  CreateCheckoutParams,
  SumUpCheckout,
  SumUpErrorType,
  SumUpProviderOptions,
} from "../types";
import { SumUpClientError } from "../types";

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
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.has(key.toLowerCase())) continue;
      out[key] = redactValue(val);
    }
    return out;
  }
  return value;
}

/** Strips sensitive keys from a JSON error body before it appears in error messages. */
function redactErrorBody(text: string): string {
  try {
    const redacted = redactValue(JSON.parse(text));
    const serialized = JSON.stringify(redacted);
    // Bound the final size regardless of shape.
    return serialized.length > 1000
      ? `${serialized.slice(0, 1000)}…`
      : serialized;
  } catch {
    // Non-JSON body (e.g. HTML gateway error) — truncate to avoid noise.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
}

/** Classify an HTTP status code into a SumUpErrorType. */
function classifyStatus(status: number): SumUpErrorType {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  // All other 4xx (400, 402, 405, 410, 422, …) are client errors: retrying
  // won't help, so classify as non-retryable "validation" rather than "server".
  return "validation";
}

/** Async sleep.  Resolves immediately when ms ≤ 0. */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute how long to wait before the next retry.
 * Respects the `Retry-After` header (seconds) when provided by the server,
 * otherwise uses bounded exponential back-off with ±30 % jitter.
 */
function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && !Number.isNaN(retryAfterSec)) {
    return Math.min(retryAfterSec * 1_000, 60_000);
  }
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * base * 0.3;
  return Math.min(base + jitter, 10_000);
}

export class SumUpClient {
  private readonly headers: Record<string, string>;

  constructor(options: SumUpProviderOptions) {
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
  private async request<T>(
    url: string,
    init: Omit<RequestInit, "headers" | "signal">,
    attempt = 0,
  ): Promise<T> {
    let res: Response;

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
    } catch (err: any) {
      const isTimeout =
        err?.name === "TimeoutError" || err?.name === "AbortError";
      const type: SumUpErrorType = isTimeout ? "timeout" : "network";

      if (isIdempotent && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        return this.request<T>(url, init, attempt + 1);
      }

      throw new SumUpClientError(
        isTimeout
          ? `SumUp request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `SumUp network error: ${err?.message ?? "unknown"}`,
        type,
      );
    }

    // ── Success ────────────────────────────────────────────────────
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      // Some success responses (e.g. DELETE/refund) carry an empty or
      // non-JSON body. Reading text first avoids res.json() throwing a raw
      // SyntaxError that would escape our typed-error contract.
      const text = await res.text().catch(() => "");
      if (text.trim() === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SumUpClientError(
          `SumUp returned a non-JSON success body (${res.status})`,
          "server",
          res.status,
        );
      }
    }

    // ── Error response ─────────────────────────────────────────────
    const bodyText = await res.text().catch(() => "");
    const type = classifyStatus(res.status);
    const isRetryable = type === "rate_limit" || type === "server";

    if (isIdempotent && isRetryable && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec =
        retryAfterHeader != null
          ? parseInt(retryAfterHeader, 10)
          : undefined;
      await sleep(backoffMs(attempt, retryAfterSec));
      return this.request<T>(url, init, attempt + 1);
    }

    throw new SumUpClientError(
      `SumUp API error (${res.status}): ${redactErrorBody(bodyText)}`,
      type,
      res.status,
    );
  }

  async createCheckout(params: CreateCheckoutParams): Promise<SumUpCheckout> {
    return this.request<SumUpCheckout>(`${SUMUP_API_BASE}/v0.1/checkouts`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getCheckout(checkoutId: string): Promise<SumUpCheckout> {
    return this.request<SumUpCheckout>(
      `${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
      { method: "GET" },
    );
  }

  async deactivateCheckout(checkoutId: string): Promise<void> {
    try {
      await this.request<void>(
        `${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      // A 404 means the checkout is already gone — treat as success.
      if (err instanceof SumUpClientError && err.type === "not_found") return;
      throw err;
    }
  }

  async refundTransaction(
    transactionId: string,
    amount?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (amount !== undefined) body.amount = amount;

    return this.request<void>(
      `${SUMUP_API_BASE}/v0.1/me/refund/${encodeURIComponent(transactionId)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }
}

