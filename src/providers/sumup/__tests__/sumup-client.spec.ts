/**
 * Unit tests for SumUpClient.
 *
 * These tests import the real SumUpClient (no vi.mock) and stub the global
 * `fetch` to exercise HTTP error classification, the 404-tolerance in
 * deactivateCheckout, and the exponential-backoff retry logic.
 *
 * NODE_ENV is already "test" so BASE_BACKOFF_MS === 0, making retries
 * instantaneous without any timer manipulation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SumUpClient } from "../core/sumup-client";
import { SumUpClientError } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clientOptions = {
  apiKey: "sup_sk_test_123",
  merchantCode: "MC12345",
  medusaUrl: "https://example.com",
  redirectUrl: "https://example.com/checkout",
};

function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SumUpClient", () => {
  let client: SumUpClient;

  beforeEach(() => {
    client = new SumUpClient(clientOptions);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── HTTP error classification ───────────────────────────────────────────

  describe("HTTP error classification", () => {
    it.each([
      [400, "validation"],
      [422, "validation"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limit"],
      [500, "server"],
      [503, "server"],
    ] as const)(
      "classifies HTTP %d as error type %s",
      async (status, expectedType) => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(mockResponse(status, { message: "error" })),
        );

        await expect(client.getCheckout("chk_123")).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof SumUpClientError && err.type === expectedType,
        );
      },
    );

    it("throws a SumUpClientError with the correct statusCode", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(401, { message: "bad key" })),
      );

      const err = await client.getCheckout("chk_123").catch((e) => e);
      expect(err).toBeInstanceOf(SumUpClientError);
      expect((err as SumUpClientError).statusCode).toBe(401);
    });

    it("redacts sensitive fields from the error message", async () => {
      const sensitiveBody = JSON.stringify({
        message: "invalid card",
        pan: "4111111111111111",
        cvv: "123",
        token: "secret_token",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => sensitiveBody,
          headers: { get: () => null },
        } as unknown as Response),
      );

      const err = await client.getCheckout("chk_123").catch((e) => e);
      expect(err.message).not.toContain("4111111111111111");
      expect(err.message).not.toContain("secret_token");
      expect(err.message).toContain("invalid card");
    });
  });

  // ── 404-tolerance in deactivateCheckout ─────────────────────────────────

  describe("deactivateCheckout", () => {
    it("resolves without throwing when the checkout is already gone (404)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(404, "not found")),
      );

      await expect(
        client.deactivateCheckout("chk_gone"),
      ).resolves.toBeUndefined();
    });

    it("throws for non-404 errors", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(500, "server error")),
      );

      await expect(
        client.deactivateCheckout("chk_123"),
      ).rejects.toBeInstanceOf(SumUpClientError);
    });
  });

  // ── Retry on transient failures (5xx) ───────────────────────────────────

  describe("retry behaviour", () => {
    it("retries a 500 error and succeeds on the next attempt", async () => {
      let calls = 0;
      const checkoutData = { id: "chk_ok", status: "PENDING" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 2) return Promise.resolve(mockResponse(500, "error"));
          return Promise.resolve(mockResponse(200, checkoutData));
        }),
      );

      const result = await client.getCheckout("chk_ok");
      expect(calls).toBe(2);
      expect(result).toMatchObject({ id: "chk_ok" });
    });

    it("retries a 429 and succeeds on the next attempt (ignores Retry-After in test mode)", async () => {
      let calls = 0;
      const checkoutData = { id: "chk_ok", status: "PAID" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 2)
            return Promise.resolve(
              mockResponse(429, "rate limited", { "retry-after": "0" }),
            );
          return Promise.resolve(mockResponse(200, checkoutData));
        }),
      );

      const result = await client.getCheckout("chk_ok");
      expect(calls).toBe(2);
      expect(result).toMatchObject({ id: "chk_ok" });
    });

    it("exhausts retries and throws SumUpClientError after MAX_RETRIES", async () => {
      // MAX_RETRIES = 3, so fetch is called 4 times (1 initial + 3 retries)
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls += 1;
          return Promise.resolve(mockResponse(500, "persistent error"));
        }),
      );

      const err = await client.getCheckout("chk_bad").catch((e) => e);
      expect(calls).toBe(4);
      expect(err).toBeInstanceOf(SumUpClientError);
      expect(err.type).toBe("server");
    });

    it("does NOT retry 4xx errors (except 429)", async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls += 1;
          return Promise.resolve(mockResponse(400, "bad request"));
        }),
      );

      await client.getCheckout("chk_bad").catch(() => {});
      expect(calls).toBe(1);
    });

    it("retries a network error and succeeds on the next attempt", async () => {
      let calls = 0;
      const checkoutData = { id: "chk_ok", status: "PENDING" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 2)
            return Promise.reject(new TypeError("Failed to fetch"));
          return Promise.resolve(mockResponse(200, checkoutData));
        }),
      );

      const result = await client.getCheckout("chk_ok");
      expect(calls).toBe(2);
      expect(result).toMatchObject({ id: "chk_ok" });
    });

    it("exhausts retries on repeated network failures and throws with type network", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      );

      const err = await client.getCheckout("chk_bad").catch((e) => e);
      expect(err).toBeInstanceOf(SumUpClientError);
      expect(err.type).toBe("network");
    });
  });

  // ── createCheckout ────────────────────────────────────────────────────────

  describe("createCheckout", () => {
    it("returns the checkout object on success", async () => {
      const checkoutData = { id: "chk_new", status: "PENDING" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(201, checkoutData)),
      );

      const result = await client.createCheckout({
        checkout_reference: "ref_abc",
        amount: 25.0,
        currency: "EUR",
        merchant_code: "MC12345",
      });

      expect(result).toMatchObject({ id: "chk_new" });
    });
  });

  // ── refundTransaction ─────────────────────────────────────────────────────

  describe("refundTransaction", () => {
    it("resolves on 204 No Content", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(204, null)),
      );
      await expect(
        client.refundTransaction("txn_001", 10.0),
      ).resolves.toBeUndefined();
    });

    it("throws SumUpClientError on 422", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockResponse(422, { message: "refund exceeds amount" }),
        ),
      );

      const err = await client
        .refundTransaction("txn_001", 9999)
        .catch((e) => e);
      expect(err).toBeInstanceOf(SumUpClientError);
      expect(err.type).toBe("validation");
    });
  });
});
