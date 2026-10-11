import { describe, it, expect, vi, beforeEach } from "vitest";
import SumUpProviderService from "../core/sumup-provider";
import { SumUpClientError } from "../types";
import type { SumUpCheckout } from "../types";

// Mock the SumUpClient
vi.mock("../core/sumup-client", () => {
  return {
    SumUpClient: vi.fn().mockImplementation(() => ({
      createCheckout: vi.fn(),
      getCheckout: vi.fn(),
      deactivateCheckout: vi.fn(),
      refundTransaction: vi.fn(),
    })),
  };
});

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  activity: vi.fn(),
  progress: vi.fn(),
  panic: vi.fn(),
  shouldLog: vi.fn(),
};

const defaultOptions = {
  apiKey: "sup_sk_test_123",
  merchantCode: "MC12345",
  medusaUrl: "https://example.com",
  redirectUrl: "https://example.com/checkout/complete",
};

function createService() {
  const service = new SumUpProviderService(
    { logger: mockLogger } as any,
    defaultOptions,
  );
  const client = (service as any).client_;
  return { service, client };
}

const makePaidCheckout = (
  overrides?: Partial<SumUpCheckout>,
): SumUpCheckout => ({
  id: "chk_abc123",
  checkout_reference: "session_123",
  amount: 25.0,
  currency: "EUR",
  merchant_code: "MC12345",
  status: "PAID",
  transactions: [
    {
      id: "txn_001",
      transaction_code: "TC001",
      amount: 25.0,
      currency: "EUR",
      status: "SUCCESSFUL",
    },
  ],
  ...overrides,
});

const makePendingCheckout = (
  overrides?: Partial<SumUpCheckout>,
): SumUpCheckout => ({
  ...makePaidCheckout(),
  status: "PENDING",
  transactions: [],
  ...overrides,
});

describe("SumUpProviderService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateOptions", () => {
    it("should throw if apiKey is missing", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          merchantCode: "MC12345",
          medusaUrl: "https://example.com",
          redirectUrl: "https://example.com/checkout",
        }),
      ).toThrow("apiKey");
    });

    it("should throw if merchantCode is missing", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          medusaUrl: "https://example.com",
          redirectUrl: "https://example.com/checkout",
        }),
      ).toThrow("merchantCode");
    });

    it("should throw if medusaUrl is missing", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          merchantCode: "MC12345",
          redirectUrl: "https://example.com/checkout",
        }),
      ).toThrow("medusaUrl");
    });

    it("should throw if redirectUrl is missing", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          merchantCode: "MC12345",
          medusaUrl: "https://example.com",
        }),
      ).toThrow("redirectUrl");
    });

    it("should not throw for valid options", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          merchantCode: "MC12345",
          medusaUrl: "https://example.com",
          redirectUrl: "https://example.com/checkout",
        }),
      ).not.toThrow();
    });

    it("should throw for a malformed medusaUrl", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          merchantCode: "MC12345",
          medusaUrl: "not a url",
          redirectUrl: "https://example.com/checkout",
        }),
      ).toThrow("valid absolute URL");
    });

    it("should throw for a non-http(s) redirectUrl scheme", () => {
      expect(() =>
        SumUpProviderService.validateOptions({
          apiKey: "sup_sk_test_123",
          merchantCode: "MC12345",
          medusaUrl: "https://example.com",
          redirectUrl: "javascript:alert(1)",
        }),
      ).toThrow(/http or https|valid absolute URL/);
    });
  });

  describe("initiatePayment", () => {
    it("should create a SumUp checkout and return session data", async () => {
      const { service, client } = createService();
      const checkout = makePendingCheckout({ id: "chk_new" });
      client.createCheckout.mockResolvedValue(checkout);

      const result = await service.initiatePayment({
        amount: 25.0,
        currency_code: "eur",
        data: {
          session_id: "sess_abc",
        },
        context: {
          idempotency_key: "idem_123",
        },
      } as any);

      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          checkout_reference: "sess_abc",
          amount: 25.0,
          currency: "EUR",
          merchant_code: "MC12345",
          return_url: "https://example.com/hooks/payment/sumup_sumup",
          redirect_url: "https://example.com/checkout/complete",
        }),
      );

      expect(result.id).toBe("chk_new");
      expect(result.data).toEqual(
        expect.objectContaining({
          id: "chk_new",
          checkout_reference: "sess_abc",
          idempotency_key: "idem_123",
        }),
      );
    });

    it("should honour a per-session redirect_url on an allowed host", async () => {
      const { service, client } = createService();
      client.createCheckout.mockResolvedValue(makePendingCheckout());

      await service.initiatePayment({
        amount: 25.0,
        currency_code: "eur",
        data: {
          session_id: "sess_abc",
          // same host as the configured redirectUrl (example.com) → allowed
          redirect_url: "https://example.com/us/checkout/complete",
        },
      } as any);

      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_url: "https://example.com/us/checkout/complete",
        }),
      );
    });

    it("should reject a per-session redirect_url on a foreign host (open-redirect guard)", async () => {
      const { service, client } = createService();

      await expect(
        service.initiatePayment({
          amount: 25.0,
          currency_code: "eur",
          data: {
            session_id: "sess_abc",
            redirect_url: "https://evil.example.net/steal",
          },
        } as any),
      ).rejects.toThrow("not allowed");
      expect(client.createCheckout).not.toHaveBeenCalled();
    });

    it("should forward guest personal_details to SumUp", async () => {
      const { service, client } = createService();
      client.createCheckout.mockResolvedValue(makePendingCheckout());

      await service.initiatePayment({
        amount: 25.0,
        currency_code: "eur",
        data: {
          session_id: "sess_abc",
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
        },
      } as any);

      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          personal_details: {
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.com",
          },
        }),
      );
    });
  });

  describe("authorizePayment", () => {
    it('should return "captured" when SumUp checkout is PAID (auto-capture)', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("captured");
      expect(result.data).toEqual(
        expect.objectContaining({
          id: "chk_abc123",
          transaction_id: "txn_001",
          transaction_code: "TC001",
        }),
      );
    });

    it('should return "pending" when SumUp checkout is PENDING', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("pending");
    });

    it('should return "error" when SumUp checkout is FAILED', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "FAILED" }),
      );

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("error");
    });

    it('should return "canceled" when SumUp checkout is EXPIRED', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "EXPIRED" }),
      );

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("canceled");
    });
  });

  describe("capturePayment", () => {
    it("should succeed when checkout is PAID (auto-capture)", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      const result = await service.capturePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.data).toEqual(
        expect.objectContaining({
          transaction_id: "txn_001",
          transaction_code: "TC001",
        }),
      );
    });

    it("should throw when checkout is not PAID", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());

      await expect(
        service.capturePayment({
          data: { id: "chk_abc123" },
        } as any),
      ).rejects.toThrow("Cannot capture");
    });
  });

  describe("cancelPayment", () => {
    it("should deactivate the checkout", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());
      client.deactivateCheckout.mockResolvedValue(undefined);

      const result = await service.cancelPayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(client.deactivateCheckout).toHaveBeenCalledWith("chk_abc123");
      expect(result.data).toEqual(expect.objectContaining({ id: "chk_abc123" }));
    });

    it("should not throw if deactivation fails", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(new Error("Network error"));

      const result = await service.cancelPayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.data).toEqual(expect.objectContaining({ id: "chk_abc123" }));
    });

    it("should skip deactivation if checkout is already expired", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "EXPIRED" }),
      );

      await service.cancelPayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(client.deactivateCheckout).not.toHaveBeenCalled();
    });

    it("should refuse to cancel a PAID checkout (requires refund instead)", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      await expect(
        service.cancelPayment({ data: { id: "chk_abc123" } } as any),
      ).rejects.toThrow("already PAID");
      expect(client.deactivateCheckout).not.toHaveBeenCalled();
    });

    it("should NOT throw when deleting a FAILED checkout (storefront session reset)", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "FAILED" }),
      );
      // Even if deactivation itself errors, delete must stay best-effort.
      client.deactivateCheckout.mockRejectedValue(
        new SumUpClientError("cannot deactivate", "conflict", 409),
      );

      const result = await service.deletePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.data).toEqual(
        expect.objectContaining({ id: "chk_abc123" }),
      );
    });
  });

  describe("refundPayment", () => {
    it("should call refundTransaction with the correct params", async () => {
      const { service, client } = createService();
      client.refundTransaction.mockResolvedValue(undefined);

      const result = await service.refundPayment({
        data: {
          id: "chk_abc123",
          transaction_id: "txn_001",
        },
        amount: 10.0,
      } as any);

      expect(client.refundTransaction).toHaveBeenCalledWith("txn_001", 10.0);
    });

    it("should look up transaction_id from checkout if not in data", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());
      client.refundTransaction.mockResolvedValue(undefined);

      const result = await service.refundPayment({
        data: { id: "chk_abc123" },
        amount: 10.0,
      } as any);

      expect(client.getCheckout).toHaveBeenCalledWith("chk_abc123");
      expect(client.refundTransaction).toHaveBeenCalledWith("txn_001", 10.0);
    });

    it("should throw if no transaction_id can be found", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());

      await expect(
        service.refundPayment({
          data: { id: "chk_abc123" },
          amount: 10.0,
        } as any),
      ).rejects.toThrow("no completed transactions");
    });
  });

  describe("deletePayment", () => {
    it("should delegate to cancelPayment", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());
      client.deactivateCheckout.mockResolvedValue(undefined);

      const result = await service.deletePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(client.deactivateCheckout).toHaveBeenCalledWith("chk_abc123");
    });
  });

  describe("retrievePayment", () => {
    it("should return the SumUp checkout data", async () => {
      const { service, client } = createService();
      const checkout = makePaidCheckout();
      client.getCheckout.mockResolvedValue(checkout);

      const result = await service.retrievePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.data).toEqual(checkout);
    });
  });

  describe("getPaymentStatus", () => {
    it.each([
      ["PENDING", "pending"],
      ["PAID", "captured"],
      ["FAILED", "error"],
      ["EXPIRED", "canceled"],
    ] as const)(
      "should map SumUp status %s to Medusa status %s",
      async (sumupStatus, medusaStatus) => {
        const { service, client } = createService();
        client.getCheckout.mockResolvedValue(
          makePaidCheckout({ status: sumupStatus as any }),
        );

        const result = await service.getPaymentStatus({
          data: { id: "chk_abc123" },
        } as any);

        expect(result.status).toBe(medusaStatus);
      },
    );
  });

  describe("updatePayment", () => {
    it("should cancel old checkout and create a new one with updated amount", async () => {
      const { service, client } = createService();
      client.deactivateCheckout.mockResolvedValue(undefined);
      client.createCheckout.mockResolvedValue(
        makePendingCheckout({ id: "chk_new456" }),
      );

      const result = await service.updatePayment({
        data: { id: "chk_abc123", checkout_reference: "session_123" },
        amount: 30.0,
        currency_code: "eur",
        context: { session_id: "session_123" },
      } as any);

      expect(client.deactivateCheckout).toHaveBeenCalledWith("chk_abc123");
      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 30.0,
          currency: "EUR",
          checkout_reference: "session_123",
        }),
      );
      expect(result.data).toEqual(
        expect.objectContaining({ id: "chk_new456" }),
      );
    });

    it("should carry personal_details through the recreate", async () => {
      const { service, client } = createService();
      client.deactivateCheckout.mockResolvedValue(undefined);
      client.createCheckout.mockResolvedValue(
        makePendingCheckout({ id: "chk_new456" }),
      );

      await service.updatePayment({
        data: {
          id: "chk_abc123",
          session_id: "session_123",
          first_name: "Ada",
          email: "ada@example.com",
        },
        amount: 30.0,
        currency_code: "eur",
      } as any);

      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          personal_details: { first_name: "Ada", email: "ada@example.com" },
        }),
      );
    });

    it("should refuse to update a checkout that is already PAID", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      await expect(
        service.updatePayment({
          data: { id: "chk_abc123" },
          amount: 30.0,
          currency_code: "eur",
        } as any),
      ).rejects.toThrow("already PAID");
      expect(client.deactivateCheckout).not.toHaveBeenCalled();
      expect(client.createCheckout).not.toHaveBeenCalled();
    });

    it("should still create new checkout if deactivation fails", async () => {
      const { service, client } = createService();
      client.deactivateCheckout.mockRejectedValue(new Error("Already expired"));
      client.createCheckout.mockResolvedValue(
        makePendingCheckout({ id: "chk_new789" }),
      );

      const result = await service.updatePayment({
        data: { id: "chk_abc123" },
        amount: 50.0,
        currency_code: "usd",
        context: { session_id: "session_456" },
      } as any);

      expect(result.data).toEqual(
        expect.objectContaining({ id: "chk_new789" }),
      );
    });
  });

  describe("getWebhookActionAndData", () => {
    it('should return "captured" for PAID checkout', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      const result = await service.getWebhookActionAndData({
        data: { id: "chk_abc123" },
        rawData: Buffer.from(""),
        headers: {},
      });

      expect(client.getCheckout).toHaveBeenCalledWith("chk_abc123");
      expect(result.action).toBe("captured");
      expect(result.data).toEqual(
        expect.objectContaining({
          session_id: "session_123",
          transaction_id: "txn_001",
        }),
      );
    });

    it('should return "failed" for FAILED checkout', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "FAILED" }),
      );

      const result = await service.getWebhookActionAndData({
        data: { id: "chk_abc123" },
        rawData: Buffer.from(""),
        headers: {},
      });

      expect(result.action).toBe("failed");
    });

    it('should return "canceled" for EXPIRED checkout', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "EXPIRED" }),
      );

      const result = await service.getWebhookActionAndData({
        data: { id: "chk_abc123" },
        rawData: Buffer.from(""),
        headers: {},
      });

      expect(result.action).toBe("canceled");
    });

    it('should return "pending" for PENDING checkout', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePendingCheckout());

      const result = await service.getWebhookActionAndData({
        data: { id: "chk_abc123" },
        rawData: Buffer.from(""),
        headers: {},
      });

      expect(result.action).toBe("pending");
    });

    it("should throw when payload is missing a checkout ID", async () => {
      const { service } = createService();

      await expect(
        service.getWebhookActionAndData({
          data: {},
          rawData: Buffer.from(""),
          headers: {},
        }),
      ).rejects.toThrow("missing a checkout ID");
    });

    it("should throw when payload checkout ID is an empty string", async () => {
      const { service } = createService();

      await expect(
        service.getWebhookActionAndData({
          data: { id: "" },
          rawData: Buffer.from(""),
          headers: {},
        }),
      ).rejects.toThrow("missing a checkout ID");
    });

    it("should return NOT_SUPPORTED for an unknown SumUp checkout status", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "UNKNOWN_STATUS" as any }),
      );

      const result = await service.getWebhookActionAndData({
        data: { id: "chk_abc123" },
        rawData: Buffer.from(""),
        headers: {},
      });

      expect(result.action).toBe("not_supported");
    });
  });

  // ── initiatePayment — input validation ────────────────────────────────────

  describe("initiatePayment – input validation", () => {
    it("should throw for zero amount", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: 0,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for negative amount", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: -5,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for NaN amount", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: NaN,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for Infinity amount", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: Infinity,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for empty currency_code", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: 10,
          currency_code: "",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("ISO-4217");
    });

    it("should throw for a currency code that is too short", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: 10,
          currency_code: "EU",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("ISO-4217");
    });

    it("should throw for a currency code that is too long", async () => {
      const { service } = createService();
      await expect(
        service.initiatePayment({
          amount: 10,
          currency_code: "EURO",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toThrow("ISO-4217");
    });

    it("should normalise a lowercase currency code to uppercase", async () => {
      const { service, client } = createService();
      client.createCheckout.mockResolvedValue(
        makePendingCheckout({ id: "chk_new" }),
      );

      await service.initiatePayment({
        amount: 10,
        currency_code: "eur",
        data: { session_id: "sess_abc" },
        context: {},
      } as any);

      expect(client.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "EUR" }),
      );
    });
  });

  // ── authorizePayment — edge cases ─────────────────────────────────────────

  describe("authorizePayment – edge cases", () => {
    it("should throw when checkout ID is missing", async () => {
      const { service } = createService();
      await expect(
        service.authorizePayment({ data: {} } as any),
      ).rejects.toThrow("checkout ID is required");
    });

    it("should return pending for an unknown SumUp status and log a warning", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "UNKNOWN" as any }),
      );

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("pending");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown status"),
      );
    });
  });

  // ── capturePayment — edge cases ───────────────────────────────────────────

  describe("capturePayment – edge cases", () => {
    it("should throw when checkout ID is missing", async () => {
      const { service } = createService();
      await expect(
        service.capturePayment({ data: {} } as any),
      ).rejects.toThrow("checkout ID is required");
    });

    it("should return data without transaction_id when transactions array is empty", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ transactions: [] }),
      );

      const result = await service.capturePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.data).not.toHaveProperty("transaction_id");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no transactions array"),
      );
    });
  });

  // ── refundPayment — edge cases ────────────────────────────────────────────

  describe("refundPayment – edge cases", () => {
    it("should throw for zero refund amount", async () => {
      const { service } = createService();
      await expect(
        service.refundPayment({
          data: { id: "chk_abc123", transaction_id: "txn_001" },
          amount: 0,
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for negative refund amount", async () => {
      const { service } = createService();
      await expect(
        service.refundPayment({
          data: { id: "chk_abc123", transaction_id: "txn_001" },
          amount: -10,
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw when refund amount exceeds the captured transaction amount", async () => {
      const { service, client } = createService();
      // makePaidCheckout has transaction amount 25.0
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      await expect(
        service.refundPayment({
          data: { id: "chk_abc123" }, // no transaction_id → will fetch checkout
          amount: 50.0,
        } as any),
      ).rejects.toThrow("exceeds captured");
    });

    it("should cap the refund even when transaction_id is already in data", async () => {
      const { service, client } = createService();
      // transaction_id present AND checkout id present: the cap must still
      // apply (captured amount is 25.0 from makePaidCheckout).
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      await expect(
        service.refundPayment({
          data: { id: "chk_abc123", transaction_id: "txn_001" },
          amount: 50.0,
        } as any),
      ).rejects.toThrow("exceeds captured");
      expect(client.refundTransaction).not.toHaveBeenCalled();
    });

    it("should still refund with a known transaction_id if the checkout lookup fails", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(
        new SumUpClientError("boom", "server", 500),
      );
      client.refundTransaction.mockResolvedValue(undefined);

      await service.refundPayment({
        data: { id: "chk_abc123", transaction_id: "txn_001" },
        amount: 10.0,
      } as any);

      expect(client.refundTransaction).toHaveBeenCalledWith("txn_001", 10.0);
    });

    it("should throw when neither transaction_id nor checkout id is provided", async () => {
      const { service } = createService();
      await expect(
        service.refundPayment({
          data: {},
          amount: 10,
        } as any),
      ).rejects.toThrow("no transaction_id");
    });
  });

  // ── retrievePayment — edge cases ──────────────────────────────────────────

  describe("retrievePayment – edge cases", () => {
    it("should throw when checkout ID is missing", async () => {
      const { service } = createService();
      await expect(
        service.retrievePayment({ data: {} } as any),
      ).rejects.toThrow("checkout ID is required");
    });
  });

  // ── getPaymentStatus — edge cases ─────────────────────────────────────────

  describe("getPaymentStatus – edge cases", () => {
    it("should throw when checkout ID is missing", async () => {
      const { service } = createService();
      await expect(
        service.getPaymentStatus({ data: {} } as any),
      ).rejects.toThrow("checkout ID is required");
    });

    it("should return pending and warn for an unknown SumUp status", async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(
        makePaidCheckout({ status: "MYSTERY" as any }),
      );

      const result = await service.getPaymentStatus({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("pending");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown status"),
      );
    });
  });

  // ── updatePayment — input validation ──────────────────────────────────────

  describe("updatePayment – input validation", () => {
    it("should throw for zero amount", async () => {
      const { service } = createService();
      await expect(
        service.updatePayment({
          data: { id: "chk_abc123" },
          amount: 0,
          currency_code: "EUR",
          context: {},
        } as any),
      ).rejects.toThrow("positive finite number");
    });

    it("should throw for an invalid currency code", async () => {
      const { service } = createService();
      await expect(
        service.updatePayment({
          data: { id: "chk_abc123" },
          amount: 10,
          currency_code: "INVALID",
          context: {},
        } as any),
      ).rejects.toThrow("ISO-4217");
    });
  });

  // ── SumUpClientError → MedusaError translation ────────────────────────────

  describe("SumUpClientError translation", () => {
    it("should translate auth errors to an UNAUTHORIZED MedusaError", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(
        new SumUpClientError("Unauthorized", "auth", 401),
      );

      await expect(
        service.authorizePayment({ data: { id: "chk_abc123" } } as any),
      ).rejects.toMatchObject({ type: "unauthorized" });
    });

    it("should translate not_found errors to a NOT_FOUND MedusaError", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(
        new SumUpClientError("Not found", "not_found", 404),
      );

      await expect(
        service.retrievePayment({ data: { id: "chk_missing" } } as any),
      ).rejects.toMatchObject({ type: "not_found" });
    });

    it("should translate validation errors to an INVALID_DATA MedusaError", async () => {
      const { service, client } = createService();
      client.createCheckout.mockRejectedValue(
        new SumUpClientError("Bad request", "validation", 400),
      );

      await expect(
        service.initiatePayment({
          amount: 10,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toMatchObject({ type: "invalid_data" });
    });

    it("should translate conflict errors to a CONFLICT MedusaError", async () => {
      const { service, client } = createService();
      client.createCheckout.mockRejectedValue(
        new SumUpClientError("Duplicate checkout", "conflict", 409),
      );

      await expect(
        service.initiatePayment({
          amount: 10,
          currency_code: "EUR",
          data: { session_id: "sess_abc" },
          context: {},
        } as any),
      ).rejects.toMatchObject({ type: "conflict" });
    });

    it("should translate rate_limit errors to an UNEXPECTED_STATE MedusaError", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(
        new SumUpClientError("Rate limited", "rate_limit", 429),
      );

      await expect(
        service.authorizePayment({ data: { id: "chk_abc123" } } as any),
      ).rejects.toMatchObject({ type: "unexpected_state" });
    });

    it("should re-throw server/network errors without translation", async () => {
      const { service, client } = createService();
      client.getCheckout.mockRejectedValue(
        new SumUpClientError("Gateway timeout", "server", 504),
      );

      await expect(
        service.authorizePayment({ data: { id: "chk_abc123" } } as any),
      ).rejects.toThrow("server error");
    });
  });
});
