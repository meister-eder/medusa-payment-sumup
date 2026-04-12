"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@medusajs/framework/utils");
const sumup_client_1 = require("./sumup-client");
const types_1 = require("../types");
// ISO-4217: 3 uppercase alpha characters.
const CURRENCY_RE = /^[A-Z]{3}$/;
const SUMUP_STATUS_MAP = {
    PENDING: utils_1.PaymentSessionStatus.PENDING,
    PAID: utils_1.PaymentSessionStatus.CAPTURED,
    FAILED: utils_1.PaymentSessionStatus.ERROR,
    EXPIRED: utils_1.PaymentSessionStatus.CANCELED,
};
class SumUpProviderService extends utils_1.AbstractPaymentProvider {
    static validateOptions(options) {
        if (!options.apiKey || typeof options.apiKey !== "string") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "SumUp API key (apiKey) is required.");
        }
        if (!options.merchantCode || typeof options.merchantCode !== "string") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "SumUp merchant code (merchantCode) is required.");
        }
        if (!options.medusaUrl || typeof options.medusaUrl !== "string") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Medusa backend URL (medusaUrl) is required.");
        }
        if (!options.redirectUrl || typeof options.redirectUrl !== "string") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Redirect URL (redirectUrl) is required.");
        }
    }
    constructor(container, options) {
        super(container, options);
        this.logger_ = container.logger;
        this.options_ = options;
        this.debug_ =
            options.debug ||
                process.env.NODE_ENV === "development" ||
                process.env.NODE_ENV === "test" ||
                false;
        this.client_ = new sumup_client_1.SumUpClient(options);
    }
    // ── Input validators ──────────────────────────────────────────────────────
    /**
     * Asserts that `amount` is a positive finite number and returns it as a
     * parsed float.  Throws INVALID_DATA otherwise.
     */
    static assertAmount(amount, ctx) {
        const n = parseFloat(String(amount));
        if (!Number.isFinite(n) || n <= 0) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: amount must be a positive finite number, got "${amount}"`);
        }
        return n;
    }
    /**
     * Asserts that `code` is a valid ISO-4217 format (3 alpha chars), normalises
     * to uppercase, and returns it.  Throws INVALID_DATA otherwise.
     */
    static assertCurrency(code, ctx) {
        const upper = typeof code === "string" ? code.toUpperCase().trim() : "";
        if (!CURRENCY_RE.test(upper)) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: currency_code must be a 3-letter ISO-4217 code, got "${code}"`);
        }
        return upper;
    }
    /**
     * Asserts that `id` is a non-empty string and returns it trimmed.
     * Throws INVALID_DATA otherwise.
     */
    static assertExternalId(id, ctx) {
        if (typeof id !== "string" || id.trim() === "") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: checkout ID is required`);
        }
        return id.trim();
    }
    /**
     * Translates a SumUpClientError into the most appropriate MedusaError type
     * so callers receive structured, actionable errors rather than raw HTTP
     * status text.  Always throws.
     */
    rethrowAsMedusaError(error, ctx) {
        if (error instanceof types_1.SumUpClientError) {
            switch (error.type) {
                case "auth":
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNAUTHORIZED, `SumUp authentication failed in ${ctx}. Verify your API key.`);
                case "not_found":
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.NOT_FOUND, `SumUp resource not found in ${ctx}.`);
                case "validation":
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `SumUp rejected the request in ${ctx}: ${error.message}`);
                case "conflict":
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.CONFLICT, `SumUp conflict in ${ctx}: ${error.message}`);
                case "rate_limit":
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.UNEXPECTED_STATE, `SumUp rate limit exceeded in ${ctx}. Please retry later.`);
                // network / timeout / server: re-throw as-is with a clear prefix
                default: {
                    const wrapped = new Error(`SumUp ${error.type} error in ${ctx}: ${error.message}`);
                    throw wrapped;
                }
            }
        }
        throw error;
    }
    /**
     * Creates a new SumUp checkout for the payment session.
     */
    async initiatePayment(input) {
        const ctx = "initiatePayment";
        // ── Input validation ────────────────────────────────────────────
        const amount = SumUpProviderService.assertAmount(input.amount, ctx);
        const currency = SumUpProviderService.assertCurrency(input.currency_code, ctx);
        const { context } = input;
        try {
            const checkoutReference = input.data?.session_id ?? crypto.randomUUID();
            if (!input.data?.session_id) {
                this.logger_.warn("SumUp: data.session_id is missing — using random UUID as checkout_reference. " +
                    "Webhook-based status updates may not work correctly.");
            }
            const webhookUrl = this.options_.medusaUrl + "/hooks/payment/sumup_sumup";
            const customer = context?.customer;
            // Merge guest data (from cart shipping address) with logged-in customer
            // context; context.customer takes precedence when present.
            const pdFirst = customer?.first_name ?? input.data?.first_name;
            const pdLast = customer?.last_name ?? input.data?.last_name;
            const pdEmail = customer?.email ?? input.data?.email;
            const personalDetails = pdFirst || pdLast || pdEmail
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
                description: input.data?.description || "SumUp payment via Medusa",
                return_url: webhookUrl,
                redirect_url: this.options_.redirectUrl,
                ...(personalDetails && { personal_details: personalDetails }),
            });
            this.debug_ &&
                this.logger_.info(`SumUp checkout ${checkout.id} created with amount ${amount} ${currency}`);
            return {
                id: checkout.id,
                data: {
                    id: checkout.id,
                    checkout_reference: checkoutReference,
                    idempotency_key: context?.idempotency_key,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * Checks the SumUp checkout status to authorize the payment.
     * SumUp auto-captures — when the checkout is PAID we return AUTHORIZED
     * so that Medusa can proceed to capture (which is a no-op verification).
     */
    async authorizePayment(input) {
        const ctx = "authorizePayment";
        const externalId = SumUpProviderService.assertExternalId(input.data?.id, ctx);
        try {
            const checkout = await this.client_.getCheckout(externalId);
            const sumupStatus = checkout.status;
            const transaction = checkout.transactions?.[0];
            switch (sumupStatus) {
                case "PAID":
                    // SumUp auto-captures. Return AUTHORIZED so Medusa's
                    // authorize → capture flow proceeds naturally.
                    this.debug_ &&
                        this.logger_.info(`SumUp payment ${externalId} is PAID — returning AUTHORIZED`);
                    return {
                        data: {
                            ...input.data,
                            transaction_id: transaction?.id,
                            transaction_code: transaction?.transaction_code,
                        },
                        status: utils_1.PaymentSessionStatus.AUTHORIZED,
                    };
                case "PENDING":
                    this.debug_ &&
                        this.logger_.info(`SumUp payment ${externalId} is still PENDING`);
                    return {
                        data: input.data,
                        status: utils_1.PaymentSessionStatus.PENDING,
                    };
                case "FAILED":
                    return {
                        data: input.data,
                        status: utils_1.PaymentSessionStatus.ERROR,
                    };
                case "EXPIRED":
                    return {
                        data: input.data,
                        status: utils_1.PaymentSessionStatus.CANCELED,
                    };
                default:
                    this.logger_.warn(`SumUp payment ${externalId} returned unknown status "${sumupStatus}" — treating as PENDING`);
                    return {
                        data: input.data,
                        status: utils_1.PaymentSessionStatus.PENDING,
                    };
            }
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * SumUp auto-captures payments. This verifies the checkout is PAID.
     */
    async capturePayment(input) {
        const ctx = "capturePayment";
        const externalId = SumUpProviderService.assertExternalId(input.data?.id, ctx);
        try {
            const checkout = await this.client_.getCheckout(externalId);
            if (checkout.status !== "PAID") {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR, `Cannot capture: SumUp checkout status is ${checkout.status}, not PAID.`);
            }
            const transactions = checkout.transactions ?? [];
            if (transactions.length === 0) {
                // PAID but no transactions array — log a warning and proceed;
                // SumUp sometimes omits this on freshly completed checkouts.
                this.logger_.warn(`SumUp checkout ${externalId} is PAID but has no transactions array. ` +
                    "transaction_id will not be available.");
                return { data: { ...input.data } };
            }
            const transaction = transactions[0];
            this.debug_ &&
                this.logger_.info(`SumUp payment ${externalId} capture confirmed`);
            return {
                data: {
                    ...input.data,
                    transaction_id: transaction.id,
                    transaction_code: transaction.transaction_code,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * Refunds a captured SumUp payment.
     */
    async refundPayment(input) {
        const ctx = "refundPayment";
        // Validate refund amount first — before any API call.
        const refundAmount = SumUpProviderService.assertAmount(input.amount, ctx);
        const transactionId = input.data?.transaction_id;
        if (!transactionId) {
            // If we don't have transaction_id yet, try to get it from the checkout
            const externalId = input.data?.id;
            if (externalId) {
                let checkout;
                try {
                    checkout = await this.client_.getCheckout(externalId);
                }
                catch (error) {
                    this.logger_.error(`Error in ${ctx} looking up checkout ${externalId}: ${error.message}`);
                    this.rethrowAsMedusaError(error, ctx);
                }
                const transactions = checkout.transactions ?? [];
                if (transactions.length === 0) {
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Cannot refund: checkout ${externalId} has no completed transactions.`);
                }
                const txn = transactions[0];
                // Guard against refunding more than was originally captured.
                if (typeof txn.amount === "number" &&
                    refundAmount > txn.amount) {
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Cannot refund ${refundAmount}: exceeds captured transaction amount of ${txn.amount}.`);
                }
                try {
                    await this.client_.refundTransaction(txn.id, refundAmount);
                }
                catch (error) {
                    this.logger_.error(`Error in ${ctx} refunding transaction ${txn.id}: ${error.message}`);
                    this.rethrowAsMedusaError(error, ctx);
                }
                this.debug_ &&
                    this.logger_.info(`SumUp refund for payment ${externalId} created with amount ${refundAmount}`);
                return {
                    data: {
                        ...input.data,
                        transaction_id: txn.id,
                    },
                };
            }
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Cannot refund: no transaction_id found in payment data.");
        }
        try {
            await this.client_.refundTransaction(transactionId, refundAmount);
            this.debug_ &&
                this.logger_.info(`SumUp refund for transaction ${transactionId} created with amount ${refundAmount}`);
            return {
                data: input.data,
            };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for transaction ${transactionId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * Cancels a pending SumUp checkout by deactivating it.
     */
    async cancelPayment(input) {
        const externalId = input.data?.id;
        try {
            if (externalId) {
                const checkout = await this.client_.getCheckout(externalId);
                if (checkout.status === "EXPIRED") {
                    this.debug_ &&
                        this.logger_.info(`SumUp checkout ${externalId} is already expired, no need to cancel`);
                    return { data: input.data };
                }
                await this.client_.deactivateCheckout(externalId);
            }
            this.debug_ &&
                this.logger_.info(`SumUp payment ${externalId} cancelled`);
            return {
                data: input.data,
            };
        }
        catch (error) {
            this.logger_.warn(`Could not cancel SumUp checkout ${externalId}: ${error.message}`);
            return { data: input.data };
        }
    }
    /**
     * Deletes a payment session. Equivalent to cancellation for SumUp.
     */
    async deletePayment(input) {
        return this.cancelPayment(input);
    }
    /**
     * Retrieves the full checkout data from SumUp.
     */
    async retrievePayment(input) {
        const ctx = "retrievePayment";
        const externalId = SumUpProviderService.assertExternalId(input.data?.id, ctx);
        try {
            const data = await this.client_.getCheckout(externalId);
            return { data: data };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * Maps SumUp checkout status to Medusa PaymentSessionStatus.
     */
    async getPaymentStatus(input) {
        const ctx = "getPaymentStatus";
        const externalId = SumUpProviderService.assertExternalId(input.data?.id, ctx);
        try {
            const checkout = await this.client_.getCheckout(externalId);
            const status = checkout.status;
            const mappedStatus = SUMUP_STATUS_MAP[status] ?? utils_1.PaymentSessionStatus.PENDING;
            if (!SUMUP_STATUS_MAP[status]) {
                this.logger_.warn(`SumUp checkout ${externalId} returned unknown status "${status}" — defaulting to PENDING`);
            }
            this.debug_ &&
                this.logger_.debug(`SumUp checkout ${externalId} status: ${status} (mapped to: ${mappedStatus})`);
            return { status: mappedStatus };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * SumUp does not support modifying a checkout after creation.
     * We cancel the old checkout and create a new one with the updated amount.
     */
    async updatePayment(input) {
        const ctx = "updatePayment";
        // ── Input validation ────────────────────────────────────────────
        const amount = SumUpProviderService.assertAmount(input.amount, ctx);
        const currency = SumUpProviderService.assertCurrency(input.currency_code, ctx);
        const externalId = input.data?.id;
        try {
            // Cancel the existing checkout (best-effort; may already be expired)
            if (externalId) {
                try {
                    await this.client_.deactivateCheckout(externalId);
                }
                catch {
                    // Ignore — checkout may already be in a terminal state
                }
            }
            // Create a new checkout with the updated amount
            const checkoutReference = input.data?.session_id ??
                input.data?.checkout_reference ??
                crypto.randomUUID();
            const webhookUrl = this.options_.medusaUrl + "/hooks/payment/sumup_sumup";
            const checkout = await this.client_.createCheckout({
                checkout_reference: checkoutReference,
                amount,
                currency,
                merchant_code: this.options_.merchantCode,
                description: input.data?.description ||
                    "SumUp payment via Medusa",
                return_url: webhookUrl,
                redirect_url: this.options_.redirectUrl,
            });
            this.debug_ &&
                this.logger_.info(`SumUp checkout updated: old=${externalId} → new=${checkout.id} (amount: ${amount} ${currency})`);
            return {
                data: {
                    id: checkout.id,
                    checkout_reference: checkoutReference,
                    idempotency_key: input.context?.idempotency_key,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${externalId}: ${error.message}`);
            this.rethrowAsMedusaError(error, ctx);
        }
    }
    /**
     * Processes SumUp webhook events.
     * SumUp does NOT sign webhooks — we always verify by calling the API.
     */
    async getWebhookActionAndData(payload) {
        const ctx = "getWebhookActionAndData";
        const { data } = payload;
        // Validate that the payload carries a checkout ID before hitting the API.
        const checkoutId = data?.id;
        if (!checkoutId || typeof checkoutId !== "string") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "SumUp webhook payload is missing a checkout ID.");
        }
        try {
            // Always re-verify via the SumUp API — never trust the webhook body alone.
            const checkout = await this.client_.getCheckout(checkoutId);
            const session_id = checkout.checkout_reference;
            const amount = new utils_1.BigNumber(checkout.amount);
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
                        action: utils_1.PaymentActions.SUCCESSFUL,
                        data: baseData,
                    };
                case "FAILED":
                    return {
                        action: utils_1.PaymentActions.FAILED,
                        data: baseData,
                    };
                case "EXPIRED":
                    return {
                        action: utils_1.PaymentActions.CANCELED,
                        data: baseData,
                    };
                case "PENDING":
                    return {
                        action: utils_1.PaymentActions.PENDING,
                        data: baseData,
                    };
                default:
                    this.logger_.warn(`SumUp webhook: checkout ${checkoutId} has unknown status "${checkout.status}"`);
                    return {
                        action: utils_1.PaymentActions.NOT_SUPPORTED,
                        data: baseData,
                    };
            }
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for checkout ${checkoutId}: ${error.message}`);
            // Attempt graceful degradation: if we can classify the error (e.g. auth
            // failure), surface it.  Otherwise re-throw so Medusa can retry.
            this.rethrowAsMedusaError(error, ctx);
        }
    }
}
SumUpProviderService.identifier = "sumup";
exports.default = SumUpProviderService;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VtdXAtcHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvcHJvdmlkZXJzL3N1bXVwL2NvcmUvc3VtdXAtcHJvdmlkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFLQSxxREFNbUM7QUFxQm5DLGlEQUE2QztBQUM3QyxvQ0FBNEM7QUFPNUMsMENBQTBDO0FBQzFDLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQztBQUVqQyxNQUFNLGdCQUFnQixHQUFzRDtJQUMxRSxPQUFPLEVBQUUsNEJBQW9CLENBQUMsT0FBTztJQUNyQyxJQUFJLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtJQUNuQyxNQUFNLEVBQUUsNEJBQW9CLENBQUMsS0FBSztJQUNsQyxPQUFPLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtDQUN2QyxDQUFDO0FBRUYsTUFBTSxvQkFBcUIsU0FBUSwrQkFBdUI7SUFReEQsTUFBTSxDQUFDLGVBQWUsQ0FBQyxPQUFnQztRQUNyRCxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sSUFBSSxPQUFPLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDMUQsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIscUNBQXFDLENBQ3RDLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxZQUFZLElBQUksT0FBTyxPQUFPLENBQUMsWUFBWSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3RFLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLGlEQUFpRCxDQUNsRCxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxPQUFPLENBQUMsU0FBUyxJQUFJLE9BQU8sT0FBTyxDQUFDLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNoRSxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJB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