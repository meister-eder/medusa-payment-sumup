import { describe, it, expect, vi, beforeEach } from "vitest";
import SumUpProviderService from "../core/sumup-provider";
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
  });

  describe("authorizePayment", () => {
    it('should return "authorized" when SumUp checkout is PAID', async () => {
      const { service, client } = createService();
      client.getCheckout.mockResolvedValue(makePaidCheckout());

      const result = await service.authorizePayment({
        data: { id: "chk_abc123" },
      } as any);

      expect(result.status).toBe("authorized");
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
      ).rejects.toThrow("transaction_id");
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
  });
});
