import type {
  CreateCheckoutParams,
  SumUpCheckout,
  SumUpProviderOptions,
} from "../types";

const SUMUP_API_BASE = "https://api.sumup.com";
const REQUEST_TIMEOUT_MS = 10_000;

export class SumUpClient {
  private apiKey: string;
  private headers: Record<string, string>;

  constructor(options: SumUpProviderOptions) {
    this.apiKey = options.apiKey;
    this.headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  async createCheckout(params: CreateCheckoutParams): Promise<SumUpCheckout> {
    const res = await fetch(`${SUMUP_API_BASE}/v0.1/checkouts`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
      signal: this.signal(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `SumUp createCheckout failed (${res.status}): ${body}`,
      );
    }

    return (await res.json()) as SumUpCheckout;
  }

  async getCheckout(checkoutId: string): Promise<SumUpCheckout> {
    const res = await fetch(
      `${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
      {
        method: "GET",
        headers: this.headers,
        signal: this.signal(),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `SumUp getCheckout failed (${res.status}): ${body}`,
      );
    }

    return (await res.json()) as SumUpCheckout;
  }

  async deactivateCheckout(checkoutId: string): Promise<void> {
    const res = await fetch(
      `${SUMUP_API_BASE}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
      {
        method: "DELETE",
        headers: this.headers,
        signal: this.signal(),
      },
    );

    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      throw new Error(
        `SumUp deactivateCheckout failed (${res.status}): ${body}`,
      );
    }
  }

  async refundTransaction(
    transactionId: string,
    amount?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (amount !== undefined) {
      body.amount = amount;
    }

    const res = await fetch(
      `${SUMUP_API_BASE}/v0.1/me/refund/${encodeURIComponent(transactionId)}`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: this.signal(),
      },
    );

    if (!res.ok) {
      const responseBody = await res.text();
      throw new Error(
        `SumUp refundTransaction failed (${res.status}): ${responseBody}`,
      );
    }
  }
}
