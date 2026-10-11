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
  protected webhookUrl_: string;
  /** Lower-cased "host:port" origins permitted for per-session redirect overrides. */
  protected allowedRedirectHosts_: Set<string>;

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
    // Fail fast on malformed URLs instead of silently building broken
    // webhook / redirect links at request time.
    for (const key of ["medusaUrl", "redirectUrl"] as const) {
      const value = options[key] as string;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `SumUp ${key} must be a valid absolute URL, got "${value}".`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `SumUp ${key} must use http or https, got "${parsed.protocol}".`,
        );
      }
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
    // Strip any trailing slash(es) so we never emit `https://host//hooks/...`,
    // which can fail to match Medusa's webhook route.
    this.webhookUrl_ =
      options.medusaUrl.replace(/\/+$/, "") + "/hooks/payment/sumup_sumup";

    // Build the allow-list for per-session redirect_url overrides. Defaults to
    // the configured redirectUrl's own host when no explicit list is given.
    this.allowedRedirectHosts_ = new Set<string>();
    try {
      this.allowedRedirectHosts_.add(new URL(options.redirectUrl).host.toLowerCase());
    } catch {
      // validateOptions already guarantees a parseable URL; ignore defensively.
    }
    for (const host of options.redirectUrlAllowedHosts ?? []) {
      if (typeof host === "string" && host.trim() !== "") {
        this.allowedRedirectHosts_.add(host.trim().toLowerCase());
      }
    }
  }

  /**
   * Resolves the redirect URL for a checkout. If the request supplies
   * `data.redirect_url`, it is honoured ONLY when its host is in the configured
   * allow-list; otherwise it is rejected (open-redirect protection). Falls back
   * to the statically configured redirectUrl when no override is present.
   */
  private resolveRedirectUrl(dataRedirect: unknown, ctx: string): string {
    if (dataRedirect === undefined || dataRedirect === null) {
      return this.options_.redirectUrl;
    }
    if (typeof dataRedirect !== "string" || dataRedirect.trim() === "") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: redirect_url must be a non-empty string when provided.`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(dataRedirect);
    } catch {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: redirect_url is not a valid absolute URL.`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: redirect_url must use http or https.`,
      );
    }
    if (!this.allowedRedirectHosts_.has(parsed.host.toLowerCase())) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: redirect_url host "${parsed.host}" is not allowed.`,
      );
    }
    return parsed.toString();
  }

  /**
   * Builds SumUp `personal_details` from logged-in customer context, falling
   * back to guest fields in `data`. Returns undefined when nothing is present.
   */
  private static buildPersonalDetails(
    customer:
      | {
          first_name?: string | null;
          last_name?: string | null;
          email?: string | null;
        }
      | undefined,
    data: Record<string, unknown> | undefined,
  ): { first_name?: string; last_name?: string; email?: string } | undefined {
    const first =
      customer?.first_name ?? (data?.first_name as string | undefined);
    const last =
      customer?.last_name ?? (data?.last_name as string | undefined);
    const email = customer?.email ?? (data?.email as string | undefined);
    if (!first && !last && !email) return undefined;
    return {
      ...(first && { first_name: first }),
      ...(last && { last_name: last }),
      ...(email && { email }),
    };
  }

  // ── Input validators ──────────────────────────────────────────────────────

  /**
   * Asserts that `amount` is a positive finite number and returns it as a
   * parsed float.  Throws INVALID_DATA otherwise.
   */
  private static assertAmount(amount: unknown, ctx: string): number {
    // Use Number() (not parseFloat) so partially-numeric junk like "12abc"
    // is rejected instead of silently becoming 12.
    const n =
      typeof amount === "number" ? amount : Number(String(amount).trim());
    if (!Number.isFinite(n) || n <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${ctx}: amount must be a positive finite number, got "${amount}"`,
      );
    }
    // Quantise to 2-decimal minor units so float noise (e.g. 19.990000000002)
    // is never sent to SumUp or used as a refund cap. SumUp's supported
    // currencies are all 2-decimal.
    return Math.round((n + Number.EPSILON) * 100) / 100;
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

      // Merge guest data (from cart shipping address) with logged-in customer
      // context; context.customer takes precedence when present.
      const personalDetails = SumUpProviderService.buildPersonalDetails(
        context?.customer,
        input.data,
      );
      const redirectUrl = this.resolveRedirectUrl(
        input.data?.redirect_url,
        ctx,
      );

      const checkout = await this.client_.createCheckout({
        checkout_reference: checkoutReference,
        amount,
        currency,
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) || "SumUp payment via Medusa",
        return_url: this.webhookUrl_,
        redirect_url: redirectUrl,
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
          // SumUp auto-captures: the funds are already taken by the time a
          // checkout is PAID. Report CAPTURED (not AUTHORIZED) so the order's
          // payment is marked captured immediately on the storefront path,
          // without depending on a later webhook. This matches getPaymentStatus,
          // which also maps PAID → CAPTURED.
          this.debug_ &&
            this.logger_.info(
              `SumUp payment ${externalId} is PAID — returning CAPTURED`,
            );
          return {
            data: {
              ...input.data,
              transaction_id: transaction?.id,
              transaction_code: transaction?.transaction_code,
            } as Record<string, unknown>,
            status: PaymentSessionStatus.CAPTURED,
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

    const externalId = input.data?.id as string | undefined;
    let transactionId = input.data?.transaction_id as string | undefined;

    try {
      // Resolve the authoritative captured transaction from the checkout when
      // we can. This lets us (a) discover the transaction_id if it isn't in
      // `data` and (b) cap the refund at the captured amount — on BOTH the
      // "id already known" and "look it up" paths, not just the latter.
      let capturedAmount: number | undefined;

      if (externalId) {
        let checkout;
        try {
          checkout = await this.client_.getCheckout(externalId);
        } catch (error: any) {
          // If we already have a transaction_id we can still refund without
          // the client-side cap (SumUp enforces it server-side). Without one
          // we cannot proceed.
          if (!transactionId) {
            this.logger_.error(
              `Error in ${ctx} looking up checkout ${externalId}: ${error.message}`,
            );
            this.rethrowAsMedusaError(error, ctx);
          }
          this.logger_.warn(
            `Could not look up checkout ${externalId} to cap refund (${error.message}); ` +
              "proceeding with known transaction_id.",
          );
        }

        const txn = checkout?.transactions?.[0];
        if (txn) {
          transactionId = transactionId ?? txn.id;
          if (typeof txn.amount === "number") capturedAmount = txn.amount;
        } else if (!transactionId) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Cannot refund: checkout ${externalId} has no completed transactions.`,
          );
        }
      }

      if (!transactionId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cannot refund: no transaction_id found in payment data.",
        );
      }

      // Guard against refunding more than was originally captured.
      // NOTE: this caps against the original captured amount, not the
      // remaining refundable balance — prior partial refunds are not
      // subtracted here (SumUp still enforces the true balance server-side).
      if (capturedAmount !== undefined && refundAmount > capturedAmount) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Cannot refund ${refundAmount}: exceeds captured transaction amount of ${capturedAmount}.`,
        );
      }

      await this.client_.refundTransaction(transactionId, refundAmount);

      this.debug_ &&
        this.logger_.info(
          `SumUp refund for transaction ${transactionId} created with amount ${refundAmount}`,
        );

      return {
        data: {
          ...input.data,
          transaction_id: transactionId,
        } as Record<string, unknown>,
      };
    } catch (error: any) {
      this.logger_.error(
        `Error in ${ctx} for ${transactionId ?? externalId}: ${error.message}`,
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

        if (checkout.status === "PAID") {
          // A PAID checkout has already captured funds and cannot be
          // deactivated — cancelling it would misrepresent a completed
          // payment. Surface this clearly; the correct remedy is a refund.
          this.logger_.warn(
            `SumUp checkout ${externalId} is already PAID and cannot be cancelled. ` +
              "Issue a refund instead if the order is being voided.",
          );
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `Cannot cancel SumUp checkout ${externalId}: it is already PAID. Refund it instead.`,
          );
        }

        await this.client_.deactivateCheckout(externalId);
      }

      this.debug_ &&
        this.logger_.info(`SumUp payment ${externalId} cancelled`);

      return {
        data: input.data as Record<string, unknown>,
      };
    } catch (error: any) {
      // Deliberate business-rule errors (e.g. "already PAID") must propagate —
      // only transient/deactivation failures are swallowed as best-effort.
      if (error instanceof MedusaError) {
        throw error;
      }
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
      // Refuse to recreate over an already-PAID checkout. If the customer paid
      // the current checkout in the race window just before this update, silently
      // deactivating it and creating a new payable checkout would orphan the
      // captured funds (and risk a double charge). Surface a conflict instead.
      if (externalId) {
        let existing;
        try {
          existing = await this.client_.getCheckout(externalId);
        } catch (error: any) {
          // Lookup failed (e.g. transient/not_found). Fall back to the
          // best-effort recreate rather than blocking a legitimate update.
          this.logger_.warn(
            `Could not verify checkout ${externalId} status before update (${error.message}); proceeding with recreate.`,
          );
        }

        if (existing?.status === "PAID") {
          throw new MedusaError(
            MedusaError.Types.CONFLICT,
            `Cannot update SumUp checkout ${externalId}: it is already PAID. ` +
              "Refund it before changing the amount.",
          );
        }

        // Cancel the existing checkout (best-effort; may already be expired)
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

      // Carry personal_details and the (validated) redirect_url across the
      // recreate so an amount/cart update doesn't silently drop them.
      const personalDetails = SumUpProviderService.buildPersonalDetails(
        input.context?.customer,
        input.data,
      );
      const redirectUrl = this.resolveRedirectUrl(
        input.data?.redirect_url,
        ctx,
      );

      const checkout = await this.client_.createCheckout({
        checkout_reference: checkoutReference,
        amount,
        currency,
        merchant_code: this.options_.merchantCode,
        description:
          (input.data?.description as string) ||
          "SumUp payment via Medusa",
        return_url: this.webhookUrl_,
        redirect_url: redirectUrl,
        ...(personalDetails && { personal_details: personalDetails }),
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
      const transaction = checkout.transactions?.[0];

      // Guard the amount: BigNumber(undefined/NaN) would throw and abort the
      // whole webhook. Fall back to the transaction amount, then to 0.
      const rawAmount =
        typeof checkout.amount === "number" && Number.isFinite(checkout.amount)
          ? checkout.amount
          : typeof transaction?.amount === "number" &&
              Number.isFinite(transaction.amount)
            ? transaction.amount
            : undefined;
      if (rawAmount === undefined) {
        this.logger_.warn(
          `SumUp webhook: checkout ${checkoutId} has no usable amount; defaulting to 0.`,
        );
      }
      const amount = new BigNumber(rawAmount ?? 0);

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
