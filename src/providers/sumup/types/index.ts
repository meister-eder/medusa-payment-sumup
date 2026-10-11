/**
 * Configuration options for the SumUp payment provider.
 */
export type SumUpProviderOptions = {
  /** SumUp API key (e.g. sup_sk_...) */
  apiKey: string;
  /** SumUp merchant code (e.g. "MXXXXXXX") */
  merchantCode: string;
  /** The URL of the Medusa backend (e.g. "https://your-medusa.com") */
  medusaUrl: string;
  /** Default redirect URL after 3DS / payment completion (storefront URL) */
  redirectUrl: string;
  /**
   * Hostnames (and optional ports) allowed when a request supplies a
   * per-session `data.redirect_url`. Any override whose origin is not in this
   * list — or, if this is omitted, not the same origin as `redirectUrl` — is
   * rejected to prevent open-redirect abuse. Example: ["shop.example.com"].
   */
  redirectUrlAllowedHosts?: string[];
  /** Enable debug logging */
  debug?: boolean;
};

export interface SumUpCheckout {
  id: string;
  checkout_reference: string;
  amount: number;
  currency: string;
  merchant_code: string;
  description?: string;
  status: SumUpCheckoutStatus;
  date?: string;
  valid_until?: string | null;
  transaction_code?: string;
  transaction_id?: string;
  transactions?: SumUpTransaction[];
  redirect_url?: string;
  merchant_name?: string;
  purpose?: string;
  [key: string]: unknown;
}

export type SumUpCheckoutStatus = "PENDING" | "FAILED" | "PAID" | "EXPIRED";

export interface SumUpTransaction {
  id: string;
  transaction_code: string;
  amount: number;
  currency: string;
  status: string;
  timestamp?: string;
  payment_type?: string;
  entry_mode?: string;
  auth_code?: string;
  internal_id?: number;
  [key: string]: unknown;
}

export interface SumUpPersonalDetails {
  first_name?: string;
  last_name?: string;
  email?: string;
}

export interface CreateCheckoutParams {
  checkout_reference: string;
  amount: number;
  currency: string;
  merchant_code: string;
  description?: string;
  return_url?: string;
  redirect_url?: string;
  valid_until?: string;
  purpose?: "CHECKOUT" | "SETUP_RECURRING_PAYMENT";
  customer_id?: string;
  personal_details?: SumUpPersonalDetails;
}

/**
 * SumUp API error response (400 errors).
 */
export interface SumUpApiError {
  message: string;
  error_code: string;
  param?: string;
}

/**
 * SumUp problem response (401/404/409 errors).
 */
export interface SumUpProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

// ── Typed client error ─────────────────────────────────────────────────────

/**
 * Error type classification for SumUp API and network failures.
 * Consumers should branch on `.type` rather than `.message` text.
 */
export type SumUpErrorType =
  | "validation" // 400 / 422
  | "auth" // 401 / 403
  | "not_found" // 404
  | "conflict" // 409
  | "rate_limit" // 429
  | "server" // 5xx
  | "network" // fetch-level failure (DNS, connection refused…)
  | "timeout"; // AbortSignal.timeout fired

/**
 * Typed error thrown by SumUpClient for all non-OK HTTP responses and
 * network-level failures.  Callers can inspect `.type` to decide how to
 * handle (surface to user, retry, fall through, etc.).
 */
export class SumUpClientError extends Error {
  readonly type: SumUpErrorType;
  readonly statusCode?: number;

  constructor(
    message: string,
    type: SumUpErrorType,
    statusCode?: number,
  ) {
    super(message);
    this.name = "SumUpClientError";
    this.type = type;
    this.statusCode = statusCode;
  }
}
