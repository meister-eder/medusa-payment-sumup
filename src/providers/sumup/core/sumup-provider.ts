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
import type { SumUpCheckoutStatus, SumUpProviderOptions } from "../types";

type InjectedDependencies = {
  logger: Logger;
};

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

  /**
   * Creates a new SumUp checkout for the payment session.
   */
  async initiatePayment(
    input: InitiatePaymentInput,
  ): Promise<InitiatePaymentOutput> {
    const { context, amount, currency_code } = input;
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
        amount: parseFloat(amount.toString()),
        currency: currency_code.toUpperCase(),
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) || "SumUp payment via Medusa",
        return_url: webhookUrl,
        redirect_url: this.options_.redirectUrl,
        ...(personalDetails && { personal_details: personalDetails }),
      });

      this.debug_ &&
        this.logger_.info(
          `SumUp checkout ${checkout.id} created with amount ${amount} ${currency_code.toUpperCase()}`,
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
      this.logger_.error(
        `Error initiating SumUp payment: ${error.message}`,
      );
      throw error;
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
    const externalId = input.data?.id as string;

    if (!externalId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Checkout ID is required",
      );
    }

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
          return {
            data: input.data as Record<string, unknown>,
            status: PaymentSessionStatus.PENDING,
          };
      }
    } catch (error: any) {
      this.logger_.error(
        `Error authorizing SumUp payment ${externalId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * SumUp auto-captures payments. This verifies the checkout is PAID.
   */
  async capturePayment(
    input: CapturePaymentInput,
  ): Promise<CapturePaymentOutput> {
    const externalId = input.data?.id as string;

    if (!externalId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Checkout ID is required",
      );
    }

    try {
      const checkout = await this.client_.getCheckout(externalId);

      if (checkout.status !== "PAID") {
        throw new MedusaError(
          MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
          `Cannot capture: SumUp checkout status is ${checkout.status}, not PAID.`,
        );
      }

      const transaction = checkout.transactions?.[0];

      this.debug_ &&
        this.logger_.info(`SumUp payment ${externalId} capture confirmed`);

      return {
        data: {
          ...input.data,
          transaction_id: transaction?.id,
          transaction_code: transaction?.transaction_code,
        } as Record<string, unknown>,
      };
    } catch (error: any) {
      this.logger_.error(
        `Error capturing SumUp payment ${externalId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Refunds a captured SumUp payment.
   */
  async refundPayment(
    input: RefundPaymentInput,
  ): Promise<RefundPaymentOutput> {
    const transactionId = input.data?.transaction_id as string;

    if (!transactionId) {
      // If we don't have transaction_id yet, try to get it from the checkout
      const externalId = input.data?.id as string;
      if (externalId) {
        const checkout = await this.client_.getCheckout(externalId);
        const txn = checkout.transactions?.[0];
        if (txn?.id) {
          const refundAmount = parseFloat(input.amount.toString());
          await this.client_.refundTransaction(txn.id, refundAmount);

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
      }

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot refund: no transaction_id found in payment data.",
      );
    }

    try {
      const refundAmount = parseFloat(input.amount.toString());
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
        `Error refunding SumUp transaction ${transactionId}: ${error.message}`,
      );
      throw error;
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
    const externalId = input.data?.id as string;

    try {
      const data = await this.client_.getCheckout(externalId);
      return { data: data as unknown as Record<string, unknown> };
    } catch (error: any) {
      this.logger_.error(
        `Error retrieving SumUp payment ${externalId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Maps SumUp checkout status to Medusa PaymentSessionStatus.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput,
  ): Promise<GetPaymentStatusOutput> {
    const externalId = input.data?.id as string;

    try {
      const checkout = await this.client_.getCheckout(externalId);
      const status = checkout.status as SumUpCheckoutStatus;
      const mappedStatus =
        SUMUP_STATUS_MAP[status] ?? PaymentSessionStatus.PENDING;

      this.debug_ &&
        this.logger_.debug(
          `SumUp checkout ${externalId} status: ${status} (mapped to: ${mappedStatus})`,
        );

      return { status: mappedStatus };
    } catch (error: any) {
      this.logger_.error(
        `Error getting SumUp payment status for ${externalId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * SumUp does not support modifying a checkout after creation.
   * We cancel the old checkout and create a new one with the updated amount.
   */
  async updatePayment(
    input: UpdatePaymentInput,
  ): Promise<UpdatePaymentOutput> {
    const externalId = input.data?.id as string;

    try {
      // Cancel the existing checkout (best-effort)
      if (externalId) {
        try {
          await this.client_.deactivateCheckout(externalId);
        } catch {
          // Ignore — checkout may already be expired or processed
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
        amount: parseFloat(input.amount.toString()),
        currency: input.currency_code.toUpperCase(),
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) ||
          "SumUp payment via Medusa",
        return_url: webhookUrl,
        redirect_url: this.options_.redirectUrl,
      });

      this.debug_ &&
        this.logger_.info(
          `SumUp checkout updated: old=${externalId} → new=${checkout.id} (amount: ${input.amount} ${input.currency_code.toUpperCase()})`,
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
        `Error updating SumUp payment ${externalId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Processes SumUp webhook events.
   * SumUp does NOT sign webhooks — we always verify by calling the API.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    const { data } = payload;

    try {
      // Retrieve checkout from SumUp to verify status (security: never trust webhook body alone)
      const checkout = await this.client_.getCheckout(data.id as string);

      if (!checkout) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Checkout not found",
        );
      }

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
          return {
            action: PaymentActions.NOT_SUPPORTED,
            data: baseData,
          };
      }
    } catch (error: any) {
      this.logger_.error(
        `Error processing SumUp webhook for checkout ${data.id}: ${error.message}`,
      );
      throw error;
    }
  }
}

export default SumUpProviderService;
