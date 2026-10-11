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
        // Fail fast on malformed URLs instead of silently building broken
        // webhook / redirect links at request time.
        for (const key of ["medusaUrl", "redirectUrl"]) {
            const value = options[key];
            let parsed;
            try {
                parsed = new URL(value);
            }
            catch {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `SumUp ${key} must be a valid absolute URL, got "${value}".`);
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `SumUp ${key} must use http or https, got "${parsed.protocol}".`);
            }
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
        // Strip any trailing slash(es) so we never emit `https://host//hooks/...`,
        // which can fail to match Medusa's webhook route.
        this.webhookUrl_ =
            options.medusaUrl.replace(/\/+$/, "") + "/hooks/payment/sumup_sumup";
        // Build the allow-list for per-session redirect_url overrides. Defaults to
        // the configured redirectUrl's own host when no explicit list is given.
        this.allowedRedirectHosts_ = new Set();
        try {
            this.allowedRedirectHosts_.add(new URL(options.redirectUrl).host.toLowerCase());
        }
        catch {
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
    resolveRedirectUrl(dataRedirect, ctx) {
        if (dataRedirect === undefined || dataRedirect === null) {
            return this.options_.redirectUrl;
        }
        if (typeof dataRedirect !== "string" || dataRedirect.trim() === "") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: redirect_url must be a non-empty string when provided.`);
        }
        let parsed;
        try {
            parsed = new URL(dataRedirect);
        }
        catch {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: redirect_url is not a valid absolute URL.`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: redirect_url must use http or https.`);
        }
        if (!this.allowedRedirectHosts_.has(parsed.host.toLowerCase())) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: redirect_url host "${parsed.host}" is not allowed.`);
        }
        return parsed.toString();
    }
    /**
     * Builds SumUp `personal_details` from logged-in customer context, falling
     * back to guest fields in `data`. Returns undefined when nothing is present.
     */
    static buildPersonalDetails(customer, data) {
        const first = customer?.first_name ?? data?.first_name;
        const last = customer?.last_name ?? data?.last_name;
        const email = customer?.email ?? data?.email;
        if (!first && !last && !email)
            return undefined;
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
    static assertAmount(amount, ctx) {
        // Use Number() (not parseFloat) so partially-numeric junk like "12abc"
        // is rejected instead of silently becoming 12.
        const n = typeof amount === "number" ? amount : Number(String(amount).trim());
        if (!Number.isFinite(n) || n <= 0) {
            throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `${ctx}: amount must be a positive finite number, got "${amount}"`);
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
            // Merge guest data (from cart shipping address) with logged-in customer
            // context; context.customer takes precedence when present.
            const personalDetails = SumUpProviderService.buildPersonalDetails(context?.customer, input.data);
            const redirectUrl = this.resolveRedirectUrl(input.data?.redirect_url, ctx);
            const checkout = await this.client_.createCheckout({
                checkout_reference: checkoutReference,
                amount,
                currency,
                merchant_code: this.options_.merchantCode,
                description: input.data?.description || "SumUp payment via Medusa",
                return_url: this.webhookUrl_,
                redirect_url: redirectUrl,
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
                    // SumUp auto-captures: the funds are already taken by the time a
                    // checkout is PAID. Report CAPTURED (not AUTHORIZED) so the order's
                    // payment is marked captured immediately on the storefront path,
                    // without depending on a later webhook. This matches getPaymentStatus,
                    // which also maps PAID → CAPTURED.
                    this.debug_ &&
                        this.logger_.info(`SumUp payment ${externalId} is PAID — returning CAPTURED`);
                    return {
                        data: {
                            ...input.data,
                            transaction_id: transaction?.id,
                            transaction_code: transaction?.transaction_code,
                        },
                        status: utils_1.PaymentSessionStatus.CAPTURED,
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
        const externalId = input.data?.id;
        let transactionId = input.data?.transaction_id;
        try {
            // Resolve the authoritative captured transaction from the checkout when
            // we can. This lets us (a) discover the transaction_id if it isn't in
            // `data` and (b) cap the refund at the captured amount — on BOTH the
            // "id already known" and "look it up" paths, not just the latter.
            let capturedAmount;
            if (externalId) {
                let checkout;
                try {
                    checkout = await this.client_.getCheckout(externalId);
                }
                catch (error) {
                    // If we already have a transaction_id we can still refund without
                    // the client-side cap (SumUp enforces it server-side). Without one
                    // we cannot proceed.
                    if (!transactionId) {
                        this.logger_.error(`Error in ${ctx} looking up checkout ${externalId}: ${error.message}`);
                        this.rethrowAsMedusaError(error, ctx);
                    }
                    this.logger_.warn(`Could not look up checkout ${externalId} to cap refund (${error.message}); ` +
                        "proceeding with known transaction_id.");
                }
                const txn = checkout?.transactions?.[0];
                if (txn) {
                    transactionId = transactionId ?? txn.id;
                    if (typeof txn.amount === "number")
                        capturedAmount = txn.amount;
                }
                else if (!transactionId) {
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Cannot refund: checkout ${externalId} has no completed transactions.`);
                }
            }
            if (!transactionId) {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, "Cannot refund: no transaction_id found in payment data.");
            }
            // Guard against refunding more than was originally captured.
            // NOTE: this caps against the original captured amount, not the
            // remaining refundable balance — prior partial refunds are not
            // subtracted here (SumUp still enforces the true balance server-side).
            if (capturedAmount !== undefined && refundAmount > capturedAmount) {
                throw new utils_1.MedusaError(utils_1.MedusaError.Types.INVALID_DATA, `Cannot refund ${refundAmount}: exceeds captured transaction amount of ${capturedAmount}.`);
            }
            await this.client_.refundTransaction(transactionId, refundAmount);
            this.debug_ &&
                this.logger_.info(`SumUp refund for transaction ${transactionId} created with amount ${refundAmount}`);
            return {
                data: {
                    ...input.data,
                    transaction_id: transactionId,
                },
            };
        }
        catch (error) {
            this.logger_.error(`Error in ${ctx} for ${transactionId ?? externalId}: ${error.message}`);
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
                if (checkout.status === "PAID") {
                    // A PAID checkout has already captured funds and cannot be
                    // deactivated — cancelling it would misrepresent a completed
                    // payment. Surface this clearly; the correct remedy is a refund.
                    this.logger_.warn(`SumUp checkout ${externalId} is already PAID and cannot be cancelled. ` +
                        "Issue a refund instead if the order is being voided.");
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.NOT_ALLOWED, `Cannot cancel SumUp checkout ${externalId}: it is already PAID. Refund it instead.`);
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
            // Deliberate business-rule errors (e.g. "already PAID") must propagate —
            // only transient/deactivation failures are swallowed as best-effort.
            if (error instanceof utils_1.MedusaError) {
                throw error;
            }
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
            // Refuse to recreate over an already-PAID checkout. If the customer paid
            // the current checkout in the race window just before this update, silently
            // deactivating it and creating a new payable checkout would orphan the
            // captured funds (and risk a double charge). Surface a conflict instead.
            if (externalId) {
                let existing;
                try {
                    existing = await this.client_.getCheckout(externalId);
                }
                catch (error) {
                    // Lookup failed (e.g. transient/not_found). Fall back to the
                    // best-effort recreate rather than blocking a legitimate update.
                    this.logger_.warn(`Could not verify checkout ${externalId} status before update (${error.message}); proceeding with recreate.`);
                }
                if (existing?.status === "PAID") {
                    throw new utils_1.MedusaError(utils_1.MedusaError.Types.CONFLICT, `Cannot update SumUp checkout ${externalId}: it is already PAID. ` +
                        "Refund it before changing the amount.");
                }
                // Cancel the existing checkout (best-effort; may already be expired)
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
            // Carry personal_details and the (validated) redirect_url across the
            // recreate so an amount/cart update doesn't silently drop them.
            const personalDetails = SumUpProviderService.buildPersonalDetails(input.context?.customer, input.data);
            const redirectUrl = this.resolveRedirectUrl(input.data?.redirect_url, ctx);
            const checkout = await this.client_.createCheckout({
                checkout_reference: checkoutReference,
                amount,
                currency,
                merchant_code: this.options_.merchantCode,
                description: input.data?.description ||
                    "SumUp payment via Medusa",
                return_url: this.webhookUrl_,
                redirect_url: redirectUrl,
                ...(personalDetails && { personal_details: personalDetails }),
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
            const transaction = checkout.transactions?.[0];
            // Guard the amount: BigNumber(undefined/NaN) would throw and abort the
            // whole webhook. Fall back to the transaction amount, then to 0.
            const rawAmount = typeof checkout.amount === "number" && Number.isFinite(checkout.amount)
                ? checkout.amount
                : typeof transaction?.amount === "number" &&
                    Number.isFinite(transaction.amount)
                    ? transaction.amount
                    : undefined;
            if (rawAmount === undefined) {
                this.logger_.warn(`SumUp webhook: checkout ${checkoutId} has no usable amount; defaulting to 0.`);
            }
            const amount = new utils_1.BigNumber(rawAmount ?? 0);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VtdXAtcHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvcHJvdmlkZXJzL3N1bXVwL2NvcmUvc3VtdXAtcHJvdmlkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFLQSxxREFNbUM7QUFxQm5DLGlEQUE2QztBQUM3QyxvQ0FBNEM7QUFPNUMsMENBQTBDO0FBQzFDLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQztBQUVqQyxNQUFNLGdCQUFnQixHQUFzRDtJQUMxRSxPQUFPLEVBQUUsNEJBQW9CLENBQUMsT0FBTztJQUNyQyxJQUFJLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtJQUNuQyxNQUFNLEVBQUUsNEJBQW9CLENBQUMsS0FBSztJQUNsQyxPQUFPLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtDQUN2QyxDQUFDO0FBRUYsTUFBTSxvQkFBcUIsU0FBUSwrQkFBdUI7SUFXeEQsTUFBTSxDQUFDLGVBQWUsQ0FBQyxPQUFnQztRQUNyRCxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sSUFBSSxPQUFPLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDMUQsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIscUNBQXFDLENBQ3RDLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxZQUFZLElBQUksT0FBTyxPQUFPLENBQUMsWUFBWSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3RFLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLGlEQUFpRCxDQUNsRCxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxPQUFPLENBQUMsU0FBUyxJQUFJLE9BQU8sT0FBTyxDQUFDLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNoRSxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5Qiw2Q0FBNkMsQ0FDOUMsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsSUFBSSxPQUFPLE9BQU8sQ0FBQyxXQUFXLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDcEUsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIseUNBQXlDLENBQzFDLENBQUM7UUFDSixDQUFDO1FBQ0Qsa0VBQWtFO1FBQ2xFLDRDQUE0QztRQUM1QyxLQUFLLE1BQU0sR0FBRyxJQUFJLENBQUMsV0FBVyxFQUFFLGFBQWEsQ0FBVSxFQUFFLENBQUM7WUFDeEQsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBVyxDQUFDO1lBQ3JDLElBQUksTUFBVyxDQUFDO1lBQ2hCLElBQUksQ0FBQztnQkFDSCxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDMUIsQ0FBQztZQUFDLE1BQU0sQ0FBQztnQkFDUCxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QixTQUFTLEdBQUcsdUNBQXVDLEtBQUssSUFBSSxDQUM3RCxDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxPQUFPLElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxRQUFRLEVBQUUsQ0FBQztnQkFDaEUsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsU0FBUyxHQUFHLGlDQUFpQyxNQUFNLENBQUMsUUFBUSxJQUFJLENBQ2pFLENBQUM7WUFDSixDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCxZQUFZLFNBQStCLEVBQUUsT0FBNkI7UUFDeEUsS0FBSyxDQUFDLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUMxQixJQUFJLENBQUMsT0FBTyxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUM7UUFDaEMsSUFBSSxDQUFDLFFBQVEsR0FBRyxPQUFPLENBQUM7UUFDeEIsSUFBSSxDQUFDLE1BQU07WUFDVCxPQUFPLENBQUMsS0FBSztnQkFDYixPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxhQUFhO2dCQUN0QyxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxNQUFNO2dCQUMvQixLQUFLLENBQUM7UUFDUixJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksMEJBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN4QywyRUFBMkU7UUFDM0Usa0RBQWtEO1FBQ2xELElBQUksQ0FBQyxXQUFXO1lBQ2QsT0FBTyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxHQUFHLDRCQUE0QixDQUFDO1FBRXZFLDJFQUEyRTtRQUMzRSx3RUFBd0U7UUFDeEUsSUFBSSxDQUFDLHFCQUFxQixHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFDL0MsSUFBSSxDQUFDO1lBQ0gsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUM7UUFDbEYsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNQLDBFQUEwRTtRQUM1RSxDQUFDO1FBQ0QsS0FBSyxNQUFNLElBQUksSUFBSSxPQUFPLENBQUMsdUJBQXVCLElBQUksRUFBRSxFQUFFLENBQUM7WUFDekQsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO2dCQUNuRCxJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxDQUFDO1lBQzVELENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0ssa0JBQWtCLENBQUMsWUFBcUIsRUFBRSxHQUFXO1FBQzNELElBQUksWUFBWSxLQUFLLFNBQVMsSUFBSSxZQUFZLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDeEQsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUNuQyxDQUFDO1FBQ0QsSUFBSSxPQUFPLFlBQVksS0FBSyxRQUFRLElBQUksWUFBWSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1lBQ25FLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLEdBQUcsR0FBRywwREFBMEQsQ0FDakUsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLE1BQVcsQ0FBQztRQUNoQixJQUFJLENBQUM7WUFDSCxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDakMsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNQLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLEdBQUcsR0FBRyw2Q0FBNkMsQ0FDcEQsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssT0FBTyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDaEUsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsR0FBRyxHQUFHLHdDQUF3QyxDQUMvQyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQy9ELE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLEdBQUcsR0FBRyx3QkFBd0IsTUFBTSxDQUFDLElBQUksbUJBQW1CLENBQzdELENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTyxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7SUFDM0IsQ0FBQztJQUVEOzs7T0FHRztJQUNLLE1BQU0sQ0FBQyxvQkFBb0IsQ0FDakMsUUFNYSxFQUNiLElBQXlDO1FBRXpDLE1BQU0sS0FBSyxHQUNULFFBQVEsRUFBRSxVQUFVLElBQUssSUFBSSxFQUFFLFVBQWlDLENBQUM7UUFDbkUsTUFBTSxJQUFJLEdBQ1IsUUFBUSxFQUFFLFNBQVMsSUFBSyxJQUFJLEVBQUUsU0FBZ0MsQ0FBQztRQUNqRSxNQUFNLEtBQUssR0FBRyxRQUFRLEVBQUUsS0FBSyxJQUFLLElBQUksRUFBRSxLQUE0QixDQUFDO1FBQ3JFLElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxLQUFLO1lBQUUsT0FBTyxTQUFTLENBQUM7UUFDaEQsT0FBTztZQUNMLEdBQUcsQ0FBQyxLQUFLLElBQUksRUFBRSxVQUFVLEVBQUUsS0FBSyxFQUFFLENBQUM7WUFDbkMsR0FBRyxDQUFDLElBQUksSUFBSSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQztZQUNoQyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUM7U0FDeEIsQ0FBQztJQUNKLENBQUM7SUFFRCw2RUFBNkU7SUFFN0U7OztPQUdHO0lBQ0ssTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFlLEVBQUUsR0FBVztRQUN0RCx1RUFBdUU7UUFDdkUsK0NBQStDO1FBQy9DLE1BQU0sQ0FBQyxHQUNMLE9BQU8sTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDdEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ2xDLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLEdBQUcsR0FBRyxtREFBbUQsTUFBTSxHQUFHLENBQ25FLENBQUM7UUFDSixDQUFDO1FBQ0QsMEVBQTBFO1FBQzFFLG9FQUFvRTtRQUNwRSxnQ0FBZ0M7UUFDaEMsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7SUFDdEQsQ0FBQztJQUVEOzs7T0FHRztJQUNLLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBYSxFQUFFLEdBQVc7UUFDdEQsTUFBTSxLQUFLLEdBQ1QsT0FBTyxJQUFJLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUM1RCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzdCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLEdBQUcsR0FBRywwREFBMEQsSUFBSSxHQUFHLENBQ3hFLENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0lBRUQ7OztPQUdHO0lBQ0ssTUFBTSxDQUFDLGdCQUFnQixDQUFDLEVBQVcsRUFBRSxHQUFXO1FBQ3RELElBQUksT0FBTyxFQUFFLEtBQUssUUFBUSxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsQ0FBQztZQUMvQyxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QixHQUFHLEdBQUcsMkJBQTJCLENBQ2xDLENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTyxFQUFFLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDbkIsQ0FBQztJQUVEOzs7O09BSUc7SUFDSyxvQkFBb0IsQ0FBQyxLQUFjLEVBQUUsR0FBVztRQUN0RCxJQUFJLEtBQUssWUFBWSx3QkFBZ0IsRUFBRSxDQUFDO1lBQ3RDLFFBQVEsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNuQixLQUFLLE1BQU07b0JBQ1QsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsa0NBQWtDLEdBQUcsd0JBQXdCLENBQzlELENBQUM7Z0JBQ0osS0FBSyxXQUFXO29CQUNkLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQzNCLCtCQUErQixHQUFHLEdBQUcsQ0FDdEMsQ0FBQztnQkFDSixLQUFLLFlBQVk7b0JBQ2YsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsaUNBQWlDLEdBQUcsS0FBSyxLQUFLLENBQUMsT0FBTyxFQUFFLENBQ3pELENBQUM7Z0JBQ0osS0FBSyxVQUFVO29CQUNiLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQzFCLHFCQUFxQixHQUFHLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUM3QyxDQUFDO2dCQUNKLEtBQUssWUFBWTtvQkFDZixNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQ2xDLGdDQUFnQyxHQUFHLHVCQUF1QixDQUMzRCxDQUFDO2dCQUNKLGlFQUFpRTtnQkFDakUsT0FBTyxDQUFDLENBQUMsQ0FBQztvQkFDUixNQUFNLE9BQU8sR0FBRyxJQUFJLEtBQUssQ0FDdkIsU0FBUyxLQUFLLENBQUMsSUFBSSxhQUFhLEdBQUcsS0FBSyxLQUFLLENBQUMsT0FBTyxFQUFFLENBQ3hELENBQUM7b0JBQ0YsTUFBTSxPQUFPLENBQUM7Z0JBQ2hCLENBQUM7WUFDSCxDQUFDO1FBQ0gsQ0FBQztRQUNELE1BQU0sS0FBSyxDQUFDO0lBQ2QsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGVBQWUsQ0FDbkIsS0FBMkI7UUFFM0IsTUFBTSxHQUFHLEdBQUcsaUJBQWlCLENBQUM7UUFDOUIsbUVBQW1FO1FBQ25FLE1BQU0sTUFBTSxHQUFHLG9CQUFvQixDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3BFLE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLGNBQWMsQ0FDbEQsS0FBSyxDQUFDLGFBQWEsRUFDbkIsR0FBRyxDQUNKLENBQUM7UUFFRixNQUFNLEVBQUUsT0FBTyxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQzFCLElBQUksQ0FBQztZQUNILE1BQU0saUJBQWlCLEdBQ3BCLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBcUIsSUFBSSxNQUFNLENBQUMsVUFBVSxFQUFFLENBQUM7WUFFNUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLENBQUM7Z0JBQzVCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLCtFQUErRTtvQkFDN0Usc0RBQXNELENBQ3pELENBQUM7WUFDSixDQUFDO1lBRUQsd0VBQXdFO1lBQ3hFLDJEQUEyRDtZQUMzRCxNQUFNLGVBQWUsR0FBRyxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FDL0QsT0FBTyxFQUFFLFFBQVEsRUFDakIsS0FBSyxDQUFDLElBQUksQ0FDWCxDQUFDO1lBQ0YsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLGtCQUFrQixDQUN6QyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFDeEIsR0FBRyxDQUNKLENBQUM7WUFFRixNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDO2dCQUNqRCxrQkFBa0IsRUFBRSxpQkFBaUI7Z0JBQ3JDLE1BQU07Z0JBQ04sUUFBUTtnQkFDUixhQUFhLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZO2dCQUN6QyxXQUFXLEVBQ1IsS0FBSyxDQUFDLElBQUksRUFBRSxXQUFzQixJQUFJLDBCQUEwQjtnQkFDbkUsVUFBVSxFQUFFLElBQUksQ0FBQyxXQUFXO2dCQUM1QixZQUFZLEVBQUUsV0FBVztnQkFDekIsR0FBRyxDQUFDLGVBQWUsSUFBSSxFQUFFLGdCQUFnQixFQUFFLGVBQWUsRUFBRSxDQUFDO2FBQzlELENBQUMsQ0FBQztZQUVILElBQUksQ0FBQyxNQUFNO2dCQUNULElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLGtCQUFrQixRQUFRLENBQUMsRUFBRSx3QkFBd0IsTUFBTSxJQUFJLFFBQVEsRUFBRSxDQUMxRSxDQUFDO1lBRUosT0FBTztnQkFDTCxFQUFFLEVBQUUsUUFBUSxDQUFDLEVBQUU7Z0JBQ2YsSUFBSSxFQUFFO29CQUNKLEVBQUUsRUFBRSxRQUFRLENBQUMsRUFBRTtvQkFDZixrQkFBa0IsRUFBRSxpQkFBaUI7b0JBQ3JDLGVBQWUsRUFBRSxPQUFPLEVBQUUsZUFBZTtpQkFDMUM7YUFDRixDQUFDO1FBQ0osQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsWUFBWSxHQUFHLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDeEQsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUN4QyxDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7O09BSUc7SUFDSCxLQUFLLENBQUMsZ0JBQWdCLENBQ3BCLEtBQTRCO1FBRTVCLE1BQU0sR0FBRyxHQUFHLGtCQUFrQixDQUFDO1FBQy9CLE1BQU0sVUFBVSxHQUFHLG9CQUFvQixDQUFDLGdCQUFnQixDQUN0RCxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFDZCxHQUFHLENBQ0osQ0FBQztRQUVGLElBQUksQ0FBQztZQUNILE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDNUQsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLE1BQTZCLENBQUM7WUFDM0QsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRS9DLFFBQVEsV0FBVyxFQUFFLENBQUM7Z0JBQ3BCLEtBQUssTUFBTTtvQkFDVCxpRUFBaUU7b0JBQ2pFLG9FQUFvRTtvQkFDcEUsaUVBQWlFO29CQUNqRSx1RUFBdUU7b0JBQ3ZFLG1DQUFtQztvQkFDbkMsSUFBSSxDQUFDLE1BQU07d0JBQ1QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsaUJBQWlCLFVBQVUsK0JBQStCLENBQzNELENBQUM7b0JBQ0osT0FBTzt3QkFDTCxJQUFJLEVBQUU7NEJBQ0osR0FBRyxLQUFLLENBQUMsSUFBSTs0QkFDYixjQUFjLEVBQUUsV0FBVyxFQUFFLEVBQUU7NEJBQy9CLGdCQUFnQixFQUFFLFdBQVcsRUFBRSxnQkFBZ0I7eUJBQ3JCO3dCQUM1QixNQUFNLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtxQkFDdEMsQ0FBQztnQkFFSixLQUFLLFNBQVM7b0JBQ1osSUFBSSxDQUFDLE1BQU07d0JBQ1QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsaUJBQWlCLFVBQVUsbUJBQW1CLENBQy9DLENBQUM7b0JBQ0osT0FBTzt3QkFDTCxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQStCO3dCQUMzQyxNQUFNLEVBQUUsNEJBQW9CLENBQUMsT0FBTztxQkFDckMsQ0FBQztnQkFFSixLQUFLLFFBQVE7b0JBQ1gsT0FBTzt3QkFDTCxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQStCO3dCQUMzQyxNQUFNLEVBQUUsNEJBQW9CLENBQUMsS0FBSztxQkFDbkMsQ0FBQztnQkFFSixLQUFLLFNBQVM7b0JBQ1osT0FBTzt3QkFDTCxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQStCO3dCQUMzQyxNQUFNLEVBQUUsNEJBQW9CLENBQUMsUUFBUTtxQkFDdEMsQ0FBQztnQkFFSjtvQkFDRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZixpQkFBaUIsVUFBVSw2QkFBNkIsV0FBVyx5QkFBeUIsQ0FDN0YsQ0FBQztvQkFDRixPQUFPO3dCQUNMLElBQUksRUFBRSxLQUFLLENBQUMsSUFBK0I7d0JBQzNDLE1BQU0sRUFBRSw0QkFBb0IsQ0FBQyxPQUFPO3FCQUNyQyxDQUFDO1lBQ04sQ0FBQztRQUNILENBQUM7UUFBQyxPQUFPLEtBQVUsRUFBRSxDQUFDO1lBQ3BCLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUNoQixZQUFZLEdBQUcsUUFBUSxVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUN0RCxDQUFDO1lBQ0YsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUN4QyxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGNBQWMsQ0FDbEIsS0FBMEI7UUFFMUIsTUFBTSxHQUFHLEdBQUcsZ0JBQWdCLENBQUM7UUFDN0IsTUFBTSxVQUFVLEdBQUcsb0JBQW9CLENBQUMsZ0JBQWdCLENBQ3RELEtBQUssQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUNkLEdBQUcsQ0FDSixDQUFDO1FBRUYsSUFBSSxDQUFDO1lBQ0gsTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUU1RCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssTUFBTSxFQUFFLENBQUM7Z0JBQy9CLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQywyQkFBMkIsRUFDN0MsNENBQTRDLFFBQVEsQ0FBQyxNQUFNLGFBQWEsQ0FDekUsQ0FBQztZQUNKLENBQUM7WUFFRCxNQUFNLFlBQVksR0FBRyxRQUFRLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztZQUVqRCxJQUFJLFlBQVksQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQzlCLDhEQUE4RDtnQkFDOUQsNkRBQTZEO2dCQUM3RCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZixrQkFBa0IsVUFBVSwwQ0FBMEM7b0JBQ3BFLHVDQUF1QyxDQUMxQyxDQUFDO2dCQUNGLE9BQU8sRUFBRSxJQUFJLEVBQUUsRUFBRSxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQTZCLEVBQUUsQ0FBQztZQUNoRSxDQUFDO1lBRUQsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRXBDLElBQUksQ0FBQyxNQUFNO2dCQUNULElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlCQUFpQixVQUFVLG9CQUFvQixDQUFDLENBQUM7WUFFckUsT0FBTztnQkFDTCxJQUFJLEVBQUU7b0JBQ0osR0FBRyxLQUFLLENBQUMsSUFBSTtvQkFDYixjQUFjLEVBQUUsV0FBVyxDQUFDLEVBQUU7b0JBQzlCLGdCQUFnQixFQUFFLFdBQVcsQ0FBQyxnQkFBZ0I7aUJBQ3BCO2FBQzdCLENBQUM7UUFDSixDQUFDO1FBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztZQUNwQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLEdBQUcsUUFBUSxVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDMUUsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUN4QyxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGFBQWEsQ0FDakIsS0FBeUI7UUFFekIsTUFBTSxHQUFHLEdBQUcsZUFBZSxDQUFDO1FBQzVCLHNEQUFzRDtRQUN0RCxNQUFNLFlBQVksR0FBRyxvQkFBb0IsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQztRQUUxRSxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQXdCLENBQUM7UUFDeEQsSUFBSSxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxjQUFvQyxDQUFDO1FBRXJFLElBQUksQ0FBQztZQUNILHdFQUF3RTtZQUN4RSxzRUFBc0U7WUFDdEUscUVBQXFFO1lBQ3JFLGtFQUFrRTtZQUNsRSxJQUFJLGNBQWtDLENBQUM7WUFFdkMsSUFBSSxVQUFVLEVBQUUsQ0FBQztnQkFDZixJQUFJLFFBQVEsQ0FBQztnQkFDYixJQUFJLENBQUM7b0JBQ0gsUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQ3hELENBQUM7Z0JBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztvQkFDcEIsa0VBQWtFO29CQUNsRSxtRUFBbUU7b0JBQ25FLHFCQUFxQjtvQkFDckIsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO3dCQUNuQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsWUFBWSxHQUFHLHdCQUF3QixVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUN0RSxDQUFDO3dCQUNGLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7b0JBQ3hDLENBQUM7b0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsOEJBQThCLFVBQVUsbUJBQW1CLEtBQUssQ0FBQyxPQUFPLEtBQUs7d0JBQzNFLHVDQUF1QyxDQUMxQyxDQUFDO2dCQUNKLENBQUM7Z0JBRUQsTUFBTSxHQUFHLEdBQUcsUUFBUSxFQUFFLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUN4QyxJQUFJLEdBQUcsRUFBRSxDQUFDO29CQUNSLGFBQWEsR0FBRyxhQUFhLElBQUksR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDeEMsSUFBSSxPQUFPLEdBQUcsQ0FBQyxNQUFNLEtBQUssUUFBUTt3QkFBRSxjQUFjLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQztnQkFDbEUsQ0FBQztxQkFBTSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7b0JBQzFCLE1BQU0sSUFBSSxtQkFBVyxDQUNuQixtQkFBVyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQzlCLDJCQUEyQixVQUFVLGlDQUFpQyxDQUN2RSxDQUFDO2dCQUNKLENBQUM7WUFDSCxDQUFDO1lBRUQsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUNuQixNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5Qix5REFBeUQsQ0FDMUQsQ0FBQztZQUNKLENBQUM7WUFFRCw2REFBNkQ7WUFDN0QsZ0VBQWdFO1lBQ2hFLCtEQUErRDtZQUMvRCx1RUFBdUU7WUFDdkUsSUFBSSxjQUFjLEtBQUssU0FBUyxJQUFJLFlBQVksR0FBRyxjQUFjLEVBQUUsQ0FBQztnQkFDbEUsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFlBQVksRUFDOUIsaUJBQWlCLFlBQVksNENBQTRDLGNBQWMsR0FBRyxDQUMzRixDQUFDO1lBQ0osQ0FBQztZQUVELE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQyxhQUFhLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFFbEUsSUFBSSxDQUFDLE1BQU07Z0JBQ1QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsZ0NBQWdDLGFBQWEsd0JBQXdCLFlBQVksRUFBRSxDQUNwRixDQUFDO1lBRUosT0FBTztnQkFDTCxJQUFJLEVBQUU7b0JBQ0osR0FBRyxLQUFLLENBQUMsSUFBSTtvQkFDYixjQUFjLEVBQUUsYUFBYTtpQkFDSDthQUM3QixDQUFDO1FBQ0osQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLFlBQVksR0FBRyxRQUFRLGFBQWEsSUFBSSxVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUN2RSxDQUFDO1lBQ0YsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUN4QyxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGFBQWEsQ0FDakIsS0FBeUI7UUFFekIsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxFQUFZLENBQUM7UUFFNUMsSUFBSSxDQUFDO1lBQ0gsSUFBSSxVQUFVLEVBQUUsQ0FBQztnQkFDZixNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUU1RCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7b0JBQ2xDLElBQUksQ0FBQyxNQUFNO3dCQUNULElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLGtCQUFrQixVQUFVLHdDQUF3QyxDQUNyRSxDQUFDO29CQUNKLE9BQU8sRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQStCLEVBQUUsQ0FBQztnQkFDekQsQ0FBQztnQkFFRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssTUFBTSxFQUFFLENBQUM7b0JBQy9CLDJEQUEyRDtvQkFDM0QsNkRBQTZEO29CQUM3RCxpRUFBaUU7b0JBQ2pFLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLGtCQUFrQixVQUFVLDRDQUE0Qzt3QkFDdEUsc0RBQXNELENBQ3pELENBQUM7b0JBQ0YsTUFBTSxJQUFJLG1CQUFXLENBQ25CLG1CQUFXLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFDN0IsZ0NBQWdDLFVBQVUsMENBQTBDLENBQ3JGLENBQUM7Z0JBQ0osQ0FBQztnQkFFRCxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDcEQsQ0FBQztZQUVELElBQUksQ0FBQyxNQUFNO2dCQUNULElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlCQUFpQixVQUFVLFlBQVksQ0FBQyxDQUFDO1lBRTdELE9BQU87Z0JBQ0wsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUErQjthQUM1QyxDQUFDO1FBQ0osQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIseUVBQXlFO1lBQ3pFLHFFQUFxRTtZQUNyRSxJQUFJLEtBQUssWUFBWSxtQkFBVyxFQUFFLENBQUM7Z0JBQ2pDLE1BQU0sS0FBSyxDQUFDO1lBQ2QsQ0FBQztZQUNELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLG1DQUFtQyxVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUNsRSxDQUFDO1lBQ0YsT0FBTyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBK0IsRUFBRSxDQUFDO1FBQ3pELENBQUM7SUFDSCxDQUFDO0lBRUQ7O09BRUc7SUFDSCxLQUFLLENBQUMsYUFBYSxDQUNqQixLQUF5QjtRQUV6QixPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbkMsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLGVBQWUsQ0FDbkIsS0FBMkI7UUFFM0IsTUFBTSxHQUFHLEdBQUcsaUJBQWlCLENBQUM7UUFDOUIsTUFBTSxVQUFVLEdBQUcsb0JBQW9CLENBQUMsZ0JBQWdCLENBQ3RELEtBQUssQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUNkLEdBQUcsQ0FDSixDQUFDO1FBRUYsSUFBSSxDQUFDO1lBQ0gsTUFBTSxJQUFJLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUN4RCxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQTBDLEVBQUUsQ0FBQztRQUM5RCxDQUFDO1FBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztZQUNwQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsWUFBWSxHQUFHLFFBQVEsVUFBVSxLQUFLLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FDdEQsQ0FBQztZQUNGLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDeEMsQ0FBQztJQUNILENBQUM7SUFFRDs7T0FFRztJQUNILEtBQUssQ0FBQyxnQkFBZ0IsQ0FDcEIsS0FBNEI7UUFFNUIsTUFBTSxHQUFHLEdBQUcsa0JBQWtCLENBQUM7UUFDL0IsTUFBTSxVQUFVLEdBQUcsb0JBQW9CLENBQUMsZ0JBQWdCLENBQ3RELEtBQUssQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUNkLEdBQUcsQ0FDSixDQUFDO1FBRUYsSUFBSSxDQUFDO1lBQ0gsTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUM1RCxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsTUFBNkIsQ0FBQztZQUN0RCxNQUFNLFlBQVksR0FDaEIsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLElBQUksNEJBQW9CLENBQUMsT0FBTyxDQUFDO1lBRTNELElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO2dCQUM5QixJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZixrQkFBa0IsVUFBVSw2QkFBNkIsTUFBTSwyQkFBMkIsQ0FDM0YsQ0FBQztZQUNKLENBQUM7WUFFRCxJQUFJLENBQUMsTUFBTTtnQkFDVCxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsa0JBQWtCLFVBQVUsWUFBWSxNQUFNLGdCQUFnQixZQUFZLEdBQUcsQ0FDOUUsQ0FBQztZQUVKLE9BQU8sRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLENBQUM7UUFDbEMsQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQ2hCLFlBQVksR0FBRyxRQUFRLFVBQVUsS0FBSyxLQUFLLENBQUMsT0FBTyxFQUFFLENBQ3RELENBQUM7WUFDRixJQUFJLENBQUMsb0JBQW9CLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3hDLENBQUM7SUFDSCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsS0FBSyxDQUFDLGFBQWEsQ0FDakIsS0FBeUI7UUFFekIsTUFBTSxHQUFHLEdBQUcsZUFBZSxDQUFDO1FBQzVCLG1FQUFtRTtRQUNuRSxNQUFNLE1BQU0sR0FBRyxvQkFBb0IsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQztRQUNwRSxNQUFNLFFBQVEsR0FBRyxvQkFBb0IsQ0FBQyxjQUFjLENBQ2xELEtBQUssQ0FBQyxhQUFhLEVBQ25CLEdBQUcsQ0FDSixDQUFDO1FBQ0YsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxFQUF3QixDQUFDO1FBRXhELElBQUksQ0FBQztZQUNILHlFQUF5RTtZQUN6RSw0RUFBNEU7WUFDNUUsdUVBQXVFO1lBQ3ZFLHlFQUF5RTtZQUN6RSxJQUFJLFVBQVUsRUFBRSxDQUFDO2dCQUNmLElBQUksUUFBUSxDQUFDO2dCQUNiLElBQUksQ0FBQztvQkFDSCxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztnQkFDeEQsQ0FBQztnQkFBQyxPQUFPLEtBQVUsRUFBRSxDQUFDO29CQUNwQiw2REFBNkQ7b0JBQzdELGlFQUFpRTtvQkFDakUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsNkJBQTZCLFVBQVUsMEJBQTBCLEtBQUssQ0FBQyxPQUFPLDhCQUE4QixDQUM3RyxDQUFDO2dCQUNKLENBQUM7Z0JBRUQsSUFBSSxRQUFRLEVBQUUsTUFBTSxLQUFLLE1BQU0sRUFBRSxDQUFDO29CQUNoQyxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUMxQixnQ0FBZ0MsVUFBVSx3QkFBd0I7d0JBQ2hFLHVDQUF1QyxDQUMxQyxDQUFDO2dCQUNKLENBQUM7Z0JBRUQscUVBQXFFO2dCQUNyRSxJQUFJLENBQUM7b0JBQ0gsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLGtCQUFrQixDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUNwRCxDQUFDO2dCQUFDLE1BQU0sQ0FBQztvQkFDUCx1REFBdUQ7Z0JBQ3pELENBQUM7WUFDSCxDQUFDO1lBRUQsZ0RBQWdEO1lBQ2hELE1BQU0saUJBQWlCLEdBQ3BCLEtBQUssQ0FBQyxJQUFJLEVBQUUsVUFBcUI7Z0JBQ2pDLEtBQUssQ0FBQyxJQUFJLEVBQUUsa0JBQTZCO2dCQUMxQyxNQUFNLENBQUMsVUFBVSxFQUFFLENBQUM7WUFFdEIscUVBQXFFO1lBQ3JFLGdFQUFnRTtZQUNoRSxNQUFNLGVBQWUsR0FBRyxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FDL0QsS0FBSyxDQUFDLE9BQU8sRUFBRSxRQUFRLEVBQ3ZCLEtBQUssQ0FBQyxJQUFJLENBQ1gsQ0FBQztZQUNGLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FDekMsS0FBSyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQ3hCLEdBQUcsQ0FDSixDQUFDO1lBRUYsTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQztnQkFDakQsa0JBQWtCLEVBQUUsaUJBQWlCO2dCQUNyQyxNQUFNO2dCQUNOLFFBQVE7Z0JBQ1IsYUFBYSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsWUFBWTtnQkFDekMsV0FBVyxFQUNSLEtBQUssQ0FBQyxJQUFJLEVBQUUsV0FBc0I7b0JBQ25DLDBCQUEwQjtnQkFDNUIsVUFBVSxFQUFFLElBQUksQ0FBQyxXQUFXO2dCQUM1QixZQUFZLEVBQUUsV0FBVztnQkFDekIsR0FBRyxDQUFDLGVBQWUsSUFBSSxFQUFFLGdCQUFnQixFQUFFLGVBQWUsRUFBRSxDQUFDO2FBQzlELENBQUMsQ0FBQztZQUVILElBQUksQ0FBQyxNQUFNO2dCQUNULElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUNmLCtCQUErQixVQUFVLFVBQVUsUUFBUSxDQUFDLEVBQUUsYUFBYSxNQUFNLElBQUksUUFBUSxHQUFHLENBQ2pHLENBQUM7WUFFSixPQUFPO2dCQUNMLElBQUksRUFBRTtvQkFDSixFQUFFLEVBQUUsUUFBUSxDQUFDLEVBQUU7b0JBQ2Ysa0JBQWtCLEVBQUUsaUJBQWlCO29CQUNyQyxlQUFlLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRSxlQUFlO2lCQUNoRDthQUNGLENBQUM7UUFDSixDQUFDO1FBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztZQUNwQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsWUFBWSxHQUFHLFFBQVEsVUFBVSxLQUFLLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FDdEQsQ0FBQztZQUNGLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDeEMsQ0FBQztJQUNILENBQUM7SUFFRDs7O09BR0c7SUFDSCxLQUFLLENBQUMsdUJBQXVCLENBQzNCLE9BQTBDO1FBRTFDLE1BQU0sR0FBRyxHQUFHLHlCQUF5QixDQUFDO1FBQ3RDLE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxPQUFPLENBQUM7UUFFekIsMEVBQTBFO1FBQzFFLE1BQU0sVUFBVSxHQUFHLElBQUksRUFBRSxFQUFFLENBQUM7UUFDNUIsSUFBSSxDQUFDLFVBQVUsSUFBSSxPQUFPLFVBQVUsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNsRCxNQUFNLElBQUksbUJBQVcsQ0FDbkIsbUJBQVcsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUM5QixpREFBaUQsQ0FDbEQsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUM7WUFDSCwyRUFBMkU7WUFDM0UsTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUU1RCxNQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsa0JBQWtCLENBQUM7WUFDL0MsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRS9DLHVFQUF1RTtZQUN2RSxpRUFBaUU7WUFDakUsTUFBTSxTQUFTLEdBQ2IsT0FBTyxRQUFRLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7Z0JBQ3JFLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTTtnQkFDakIsQ0FBQyxDQUFDLE9BQU8sV0FBVyxFQUFFLE1BQU0sS0FBSyxRQUFRO29CQUNyQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUM7b0JBQ3JDLENBQUMsQ0FBQyxXQUFXLENBQUMsTUFBTTtvQkFDcEIsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUNsQixJQUFJLFNBQVMsS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDNUIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQ2YsMkJBQTJCLFVBQVUseUNBQXlDLENBQy9FLENBQUM7WUFDSixDQUFDO1lBQ0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxpQkFBUyxDQUFDLFNBQVMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUU3QyxNQUFNLFFBQVEsR0FBRztnQkFDZixVQUFVO2dCQUNWLE1BQU07Z0JBQ04sY0FBYyxFQUFFLFdBQVcsRUFBRSxFQUFFO2dCQUMvQixnQkFBZ0IsRUFBRSxXQUFXLEVBQUUsZ0JBQWdCO2FBQ2hELENBQUM7WUFFRixRQUFRLFFBQVEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDeEIsS0FBSyxNQUFNO29CQUNULE9BQU87d0JBQ0wsTUFBTSxFQUFFLHNCQUFjLENBQUMsVUFBVTt3QkFDakMsSUFBSSxFQUFFLFFBQVE7cUJBQ2YsQ0FBQztnQkFDSixLQUFLLFFBQVE7b0JBQ1gsT0FBTzt3QkFDTCxNQUFNLEVBQUUsc0JBQWMsQ0FBQyxNQUFNO3dCQUM3QixJQUFJLEVBQUUsUUFBUTtxQkFDZixDQUFDO2dCQUNKLEtBQUssU0FBUztvQkFDWixPQUFPO3dCQUNMLE1BQU0sRUFBRSxzQkFBYyxDQUFDLFFBQVE7d0JBQy9CLElBQUksRUFBRSxRQUFRO3FCQUNmLENBQUM7Z0JBQ0osS0FBSyxTQUFTO29CQUNaLE9BQU87d0JBQ0wsTUFBTSxFQUFFLHNCQUFjLENBQUMsT0FBTzt3QkFDOUIsSUFBSSxFQUFFLFFBQVE7cUJBQ2YsQ0FBQztnQkFDSjtvQkFDRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FDZiwyQkFBMkIsVUFBVSx3QkFBd0IsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUNoRixDQUFDO29CQUNGLE9BQU87d0JBQ0wsTUFBTSxFQUFFLHNCQUFjLENBQUMsYUFBYTt3QkFDcEMsSUFBSSxFQUFFLFFBQVE7cUJBQ2YsQ0FBQztZQUNOLENBQUM7UUFDSCxDQUFDO1FBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztZQUNwQixJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FDaEIsWUFBWSxHQUFHLGlCQUFpQixVQUFVLEtBQUssS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUMvRCxDQUFDO1lBQ0Ysd0VBQXdFO1lBQ3hFLGlFQUFpRTtZQUNqRSxJQUFJLENBQUMsb0JBQW9CLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3hDLENBQUM7SUFDSCxDQUFDOztBQXIxQk0sK0JBQVUsR0FBRyxPQUFPLENBQUM7QUF3MUI5QixrQkFBZSxvQkFBb0IsQ0FBQyJ9