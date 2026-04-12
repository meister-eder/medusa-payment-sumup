import {
  Logger,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types";
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
} from "@medusajs/types";
import { SumUpClient } from "./sumup-client";
import { SumUpClientError } from "../types";
import type { SumUpCheckoutStatus, SumUpProviderOptions } from "../types";

type InjectedDependencies = {
  logger: Logger;
};

// ISO-4217: 3 uppercase alpha characters.
const CURRENCY_RE = /^[A-Z]{3}$/;

const SUMUP_STATUS_MAP: Record<SumUpCheckoutStatus, PaymentSessionStatus> = {
  PENDING: PaymentSessionStatus.PENDING,
  PAID: PaymentSessionStatus.CAPTURED,
  FAILED: PaymentSessionStatus.ERROR,
  EXPIRED: PaymentSessionStatus.CANCELED,
};

class SumUpProviderService extends AbstractPaymentProvider {
  static identifier = "sumup";

  protected logger_: Logger;
  protected options_: SumUpProviderOptions;
  protected client_: SumUpClient;
  protected debug_: boolean;

  static validateOptions(options: Record<string, unknown>): void {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SumUp API key (apiKey) is required.",
      );
    }
    if (!options.merchantCode || typeof options.merchantCode !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SumUp merchant code (merchantCode) is required.",
      );
    }
    if (!options.medusaUrl || typeof options.medusaUrl !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Medusa backend URL (medusaUrl) is required.",
      );
    }
    if (!options.redirectUrl || typeof options.redirectUrl !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Redirect URL (redirectUrl) is required.",
      );
    }
  }

  constructor(container: InjectedDependencies, options: SumUpProviderOptions) {
    super(container, options);
    this.logger_ = container.logger;
    this.options_ = options;
    this.debug_ =
      options.debug ||
      process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test" ||
      false;
    this.client_ = new SumUpClient(options);
  }

  // ── Input validators ──────────────────────────────────────────────────────

  /**
   * Asserts that `amount` is a positive finite number and returns it as a
   * parsed float.  Throws INVALID_DATA otherwise.
   */
  private static assertAmount(amount: unknown, ctx: string): number {
    const n = parseFloat(String(amount));
    if (!Number.isFinite(n) || n <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: amount must be a positive finite number, got "${amount}"`,
      );
    }
    return n;
  }

  /**
   * Asserts that `code` is a valid ISO-4217 format (3 alpha chars), normalises
   * to uppercase, and returns it.  Throws INVALID_DATA otherwise.
   */
  private static assertCurrency(code: unknown, ctx: string): string {
    const upper =
      typeof code === "string" ? code.toUpperCase().trim() : "";
    if (!CURRENCY_RE.test(upper)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: currency_code must be a 3-letter ISO-4217 code, got "${code}"`,
      );
    }
    return upper;
  }

  /**
   * Asserts that `id` is a non-empty string and returns it trimmed.
   * Throws INVALID_DATA otherwise.
   */
  private static assertExternalId(id: unknown, ctx: string): string {
    if (typeof id !== "string" || id.trim() === "") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: checkout ID is required`,
      );
    }
    return id.trim();
  }

  /**
   * Translates a SumUpClientError into the most appropriate MedusaError type
   * so callers receive structured, actionable errors rather than raw HTTP
   * status text.  Always throws.
   */
  private rethrowAsMedusaError(error: unknown, ctx: string): never {
    if (error instanceof SumUpClientError) {
      switch (error.type) {
        case "auth":
          throw new MedusaError(
            MedusaError.Types.UNAUTHORIZED,
            `SumUp authentication failed in ${ctx}. Verify your API key.`,
          );
        case "not_found":
          throw new MedusaError(
            MedusaError.Types.NOT_FOUND,
            `SumUp resource not found in ${ctx}.`,
          );
        case "validation":
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `SumUp rejected the request in ${ctx}: ${error.message}`,
          );
        case "conflict":
          throw new MedusaError(
            MedusaError.Types.CONFLICT,
            `SumUp conflict in ${ctx}: ${error.message}`,
          );
        case "rate_limit":
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            `SumUp rate limit exceeded in ${ctx}. Please retry later.`,
          );
        // network / timeout / server: re-throw as-is with a clear prefix
        default: {
          const wrapped = new Error(
            `SumUp ${error.type} error in ${ctx}: ${error.message}`,
          );
          throw wrapped;
        }
      }
    }
    throw error;
  }

  /**
   * Creates a new SumUp checkout for the payment session.
   */
  async initiatePayment(
    input: InitiatePaymentInput,
  ): Promise<InitiatePaymentOutput> {
    const ctx = "initiatePayment";
    // ── Input validation ────────────────────────────────────────────
    const amount = SumUpProviderService.assertAmount(input.amount, ctx);
    const currency = SumUpProviderService.assertCurrency(
      input.currency_code,
      ctx,
    );

    const { context } = input;
    try {
      const checkoutReference =
        (input.data?.session_id as string) ?? crypto.randomUUID();

      if (!input.data?.session_id) {
        this.logger_.warn(
          "SumUp: data.session_id is missing — using random UUID as checkout_reference. " +
            "Webhook-based status updates may not work correctly.",
        );
      }

      const webhookUrl =
        this.options_.medusaUrl + "/hooks/payment/sumup_sumup";

      const customer = context?.customer;
      // Merge guest data (from cart shipping address) with logged-in customer
      // context; context.customer takes precedence when present.
      const pdFirst =
        customer?.first_name ?? (input.data?.first_name as string | undefined);
      const pdLast =
        customer?.last_name ?? (input.data?.last_name as string | undefined);
      const pdEmail =
        customer?.email ?? (input.data?.email as string | undefined);
      const personalDetails =
        pdFirst || pdLast || pdEmail
          ? {
              ...(pdFirst && { first_name: pdFirst }),
              ...(pdLast && { last_name: pdLast }),
              ...(pdEmail && { email: pdEmail }),
            }
          : undefined;

      const checkout = await this.client_.createCheckout({
        checkout_reference: checkoutReference,
        amount,
        currency,
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) || "SumUp payment via Medusa",
        return_url: webhookUrl,
        redirect_url: this.options_.redirectUrl,
        ...(personalDetails && { personal_details: personalDetails }),
      });

      this.debug_ &&
        this.logger_.info(
          `SumUp checkout ${checkout.id} created with amount ${amount} ${currency}`,
        );

      return {
        id: checkout.id,
        data: {
          id: checkout.id,
          checkout_reference: checkoutReference,
          idempotency_key: context?.idempotency_key,
        },
      };
    } catch (error: any) {
      this.logger_.error(`Error in ${ctx}: ${error.message}`);
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * Checks the SumUp checkout status to authorize the payment.
   * SumUp auto-captures — when the checkout is PAID we return AUTHORIZED
   * so that Medusa can proceed to capture (which is a no-op verification).
   */
  async authorizePayment(
    input: AuthorizePaymentInput,
  ): Promise<AuthorizePaymentOutput> {
    const ctx = "authorizePayment";
    const externalId = SumUpProviderService.assertExternalId(
      input.data?.id,
      ctx,
    );

    try {
      const checkout = await this.client_.getCheckout(externalId);
      const sumupStatus = checkout.status as SumUpCheckoutStatus;
      const transaction = checkout.transactions?.[0];

      switch (sumupStatus) {
        case "PAID":
          // SumUp auto-captures. Return AUTHORIZED so Medusa's
          // authorize → capture flow proceeds naturally.
          this.debug_ &&
            this.logger_.info(
              `SumUp payment ${externalId} is PAID — returning AUTHORIZED`,
            );
          return {
            data: {
              ...input.data,
              transaction_id: transaction?.id,
              transaction_code: transaction?.transaction_code,
            } as Record<string, unknown>,
            status: PaymentSessionStatus.AUTHORIZED,
          };

        case "PENDING":
          this.debug_ &&
            this.logger_.info(
              `SumUp payment ${externalId} is still PENDING`,
            );
          return {
            data: input.data as Record<string, unknown>,
            status: PaymentSessionStatus.PENDING,
          };

        case "FAILED":
          return {
            data: input.data as Record<string, unknown>,
            status: PaymentSessionStatus.ERROR,
          };

        case "EXPIRED":
          return {
            data: input.data as Record<string, unknown>,
            status: PaymentSessionStatus.CANCELED,
          };

        default:
          this.logger_.warn(
            `SumUp payment ${externalId} returned unknown status "${sumupStatus}" — treating as PENDING`,
          );
          return {
            data: input.data as Record<string, unknown>,
            status: PaymentSessionStatus.PENDING,
          };
      }
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for ${externalId}: ${error.message}`,
      );
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * SumUp auto-captures payments. This verifies the checkout is PAID.
   */
  async capturePayment(
    input: CapturePaymentInput,
  ): Promise<CapturePaymentOutput> {
    const ctx = "capturePayment";
    const externalId = SumUpProviderService.assertExternalId(
      input.data?.id,
      ctx,
    );

    try {
      const checkout = await this.client_.getCheckout(externalId);

      if (checkout.status !== "PAID") {
        throw new MedusaError(
          MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
          `Cannot capture: SumUp checkout status is ${checkout.status}, not PAID.`,
        );
      }

      const transactions = checkout.transactions ?? [];

      if (transactions.length === 0) {
        // PAID but no transactions array — log a warning and proceed;
        // SumUp sometimes omits this on freshly completed checkouts.
        this.logger_.warn(
          `SumUp checkout ${externalId} is PAID but has no transactions array. ` +
            "transaction_id will not be available.",
        );
        return { data: { ...input.data } as Record<string, unknown> };
      }

      const transaction = transactions[0];

      this.debug_ &&
        this.logger_.info(`SumUp payment ${externalId} capture confirmed`);

      return {
        data: {
          ...input.data,
          transaction_id: transaction.id,
          transaction_code: transaction.transaction_code,
        } as Record<string, unknown>,
      };
    } catch (error: any) {
      this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * Refunds a captured SumUp payment.
   */
  async refundPayment(
    input: RefundPaymentInput,
  ): Promise<RefundPaymentOutput> {
    const ctx = "refundPayment";
    // Validate refund amount first — before any API call.
    const refundAmount = SumUpProviderService.assertAmount(input.amount, ctx);

    const transactionId = input.data?.transaction_id as string;

    if (!transactionId) {
      // If we don't have transaction_id yet, try to get it from the checkout
      const externalId = input.data?.id as string;
      if (externalId) {
        let checkout;
        try {
          checkout = await this.client_.getCheckout(externalId);
        } catch (error: any) {
          this.logger_.error(
            `Error in ${ctx} looking up checkout ${externalId}: ${error.message}`,
          );
          this.rethrowAsMedusaError(error, ctx);
        }

        const transactions = checkout!.transactions ?? [];

        if (transactions.length === 0) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Cannot refund: checkout ${externalId} has no completed transactions.`,
          );
        }

        const txn = transactions[0];

        // Guard against refunding more than was originally captured.
        if (
          typeof txn.amount === "number" &&
          refundAmount > txn.amount
        ) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Cannot refund ${refundAmount}: exceeds captured transaction amount of ${txn.amount}.`,
          );
        }

        try {
          await this.client_.refundTransaction(txn.id, refundAmount);
        } catch (error: any) {
          this.logger_.error(
            `Error in ${ctx} refunding transaction ${txn.id}: ${error.message}`,
          );
          this.rethrowAsMedusaError(error, ctx);
        }

        this.debug_ &&
          this.logger_.info(
            `SumUp refund for payment ${externalId} created with amount ${refundAmount}`,
          );

        return {
          data: {
            ...input.data,
            transaction_id: txn.id,
          } as Record<string, unknown>,
        };
      }

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot refund: no transaction_id found in payment data.",
      );
    }

    try {
      await this.client_.refundTransaction(transactionId, refundAmount);

      this.debug_ &&
        this.logger_.info(
          `SumUp refund for transaction ${transactionId} created with amount ${refundAmount}`,
        );

      return {
        data: input.data as Record<string, unknown>,
      };
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for transaction ${transactionId}: ${error.message}`,
      );
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * Cancels a pending SumUp checkout by deactivating it.
   */
  async cancelPayment(
    input: CancelPaymentInput,
  ): Promise<CancelPaymentOutput> {
    const externalId = input.data?.id as string;

    try {
      if (externalId) {
        const checkout = await this.client_.getCheckout(externalId);

        if (checkout.status === "EXPIRED") {
          this.debug_ &&
            this.logger_.info(
              `SumUp checkout ${externalId} is already expired, no need to cancel`,
            );
          return { data: input.data as Record<string, unknown> };
        }

        await this.client_.deactivateCheckout(externalId);
      }

      this.debug_ &&
        this.logger_.info(`SumUp payment ${externalId} cancelled`);

      return {
        data: input.data as Record<string, unknown>,
      };
    } catch (error: any) {
      this.logger_.warn(
        `Could not cancel SumUp checkout ${externalId}: ${error.message}`,
      );
      return { data: input.data as Record<string, unknown> };
    }
  }

  /**
   * Deletes a payment session. Equivalent to cancellation for SumUp.
   */
  async deletePayment(
    input: DeletePaymentInput,
  ): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input);
  }

  /**
   * Retrieves the full checkout data from SumUp.
   */
  async retrievePayment(
    input: RetrievePaymentInput,
  ): Promise<RetrievePaymentOutput> {
    const ctx = "retrievePayment";
    const externalId = SumUpProviderService.assertExternalId(
      input.data?.id,
      ctx,
    );

    try {
      const data = await this.client_.getCheckout(externalId);
      return { data: data as unknown as Record<string, unknown> };
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for ${externalId}: ${error.message}`,
      );
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * Maps SumUp checkout status to Medusa PaymentSessionStatus.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput,
  ): Promise<GetPaymentStatusOutput> {
    const ctx = "getPaymentStatus";
    const externalId = SumUpProviderService.assertExternalId(
      input.data?.id,
      ctx,
    );

    try {
      const checkout = await this.client_.getCheckout(externalId);
      const status = checkout.status as SumUpCheckoutStatus;
      const mappedStatus =
        SUMUP_STATUS_MAP[status] ?? PaymentSessionStatus.PENDING;

      if (!SUMUP_STATUS_MAP[status]) {
        this.logger_.warn(
          `SumUp checkout ${externalId} returned unknown status "${status}" — defaulting to PENDING`,
        );
      }

      this.debug_ &&
        this.logger_.debug(
          `SumUp checkout ${externalId} status: ${status} (mapped to: ${mappedStatus})`,
        );

      return { status: mappedStatus };
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for ${externalId}: ${error.message}`,
      );
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * SumUp does not support modifying a checkout after creation.
   * We cancel the old checkout and create a new one with the updated amount.
   */
  async updatePayment(
    input: UpdatePaymentInput,
  ): Promise<UpdatePaymentOutput> {
    const ctx = "updatePayment";
    // ── Input validation ────────────────────────────────────────────
    const amount = SumUpProviderService.assertAmount(input.amount, ctx);
    const currency = SumUpProviderService.assertCurrency(
      input.currency_code,
      ctx,
    );
    const externalId = input.data?.id as string | undefined;

    try {
      // Cancel the existing checkout (best-effort; may already be expired)
      if (externalId) {
        try {
          await this.client_.deactivateCheckout(externalId);
        } catch {
          // Ignore — checkout may already be in a terminal state
        }
      }

      // Create a new checkout with the updated amount
      const checkoutReference =
        (input.data?.session_id as string) ??
        (input.data?.checkout_reference as string) ??
        crypto.randomUUID();

      const webhookUrl =
        this.options_.medusaUrl + "/hooks/payment/sumup_sumup";

      const checkout = await this.client_.createCheckout({
        checkout_reference: checkoutReference,
        amount,
        currency,
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) ||
          "SumUp payment via Medusa",
        return_url: webhookUrl,
        redirect_url: this.options_.redirectUrl,
      });

      this.debug_ &&
        this.logger_.info(
          `SumUp checkout updated: old=${externalId} → new=${checkout.id} (amount: ${amount} ${currency})`,
        );

      return {
        data: {
          id: checkout.id,
          checkout_reference: checkoutReference,
          idempotency_key: input.context?.idempotency_key,
        },
      };
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for ${externalId}: ${error.message}`,
      );
      this.rethrowAsMedusaError(error, ctx);
    }
  }

  /**
   * Processes SumUp webhook events.
   * SumUp does NOT sign webhooks — we always verify by calling the API.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    const ctx = "getWebhookActionAndData";
    const { data } = payload;

    // Validate that the payload carries a checkout ID before hitting the API.
    const checkoutId = data?.id;
    if (!checkoutId || typeof checkoutId !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SumUp webhook payload is missing a checkout ID.",
      );
    }

    try {
      // Always re-verify via the SumUp API — never trust the webhook body alone.
      const checkout = await this.client_.getCheckout(checkoutId);

      const session_id = checkout.checkout_reference;
      const amount = new BigNumber(checkout.amount);
      const transaction = checkout.transactions?.[0];

      const baseData = {
        session_id,
        amount,
        transaction_id: transaction?.id,
        transaction_code: transaction?.transaction_code,
      };

      switch (checkout.status) {
        case "PAID":
          return {
            action: PaymentActions.SUCCESSFUL,
            data: baseData,
          };
        case "FAILED":
          return {
            action: PaymentActions.FAILED,
            data: baseData,
          };
        case "EXPIRED":
          return {
            action: PaymentActions.CANCELED,
            data: baseData,
          };
        case "PENDING":
          return {
            action: PaymentActions.PENDING,
            data: baseData,
          };
        default:
          this.logger_.warn(
            `SumUp webhook: checkout ${checkoutId} has unknown status "${checkout.status}"`,
          );
          return {
            action: PaymentActions.NOT_SUPPORTED,
            data: baseData,
          };
      }
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for checkout ${checkoutId}: ${error.message}`,
      );
      // Attempt graceful degradation: if we can classify the error (e.g. auth
      // failure), surface it.  Otherwise re-throw so Medusa can retry.
      this.rethrowAsMedusaError(error, ctx);
    }
  }
}

export default SumUpProviderService;
