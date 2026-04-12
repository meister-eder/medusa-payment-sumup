# SumUp Payments for Medusa

A SumUp payment provider plugin for [Medusa](https://medusajs.com/) V2.
Inspired by https://github.com/VariableVic/mollie-payments-medusa and mostly implemented by Claude.

> [!WARNING]
> This plugin has not been tested on a live store. Please conduct thorough testing before using it in a production environment. I am not responsible for any missed or failed payments resulting from the use of this plugin. If you encounter any issues, please report them [here](https://github.com/meister-eder/medusa-payment-sumup/issues).

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Configuration Options](#configuration-options)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
- [Client-Side Integration](#client-side-integration)
- [License](#license)

## Features

- **SumUp Checkout**: Creates a hosted SumUp checkout session that customers complete via the SumUp Card Widget or a custom card form.
- **Webhook Support**: Receives real-time checkout status updates via SumUp webhooks.
- **Refunds**: Supports full and partial refunds via the SumUp Transactions API.
- **No extra dependencies**: Uses the native Node.js `fetch` API — no additional HTTP client needed.

## Prerequisites

- Medusa server v2.3.0 or later
- Node.js v20 or later
- A [SumUp](https://sumup.com/) merchant account with a valid API key and merchant code

> [!NOTE]
> You can find your API key and merchant code in your SumUp Dashboard under **Settings → Developer → API Keys**.

## Installation

```bash
npm install medusa-payment-sumup
# or
yarn add medusa-payment-sumup
```

## Configuration

Add the provider to the `@medusajs/payment` module in your `medusa-config.ts` file:

```ts
modules: [
  // ... other modules
  {
    resolve: "@medusajs/payment",
    options: {
      providers: [
        // ... other providers
        {
          resolve: "medusa-payment-sumup/providers/sumup",
          id: "sumup",
          options: {
            apiKey: process.env.SUMUP_API_KEY,
            merchantCode: process.env.SUMUP_MERCHANT_CODE,
            medusaUrl: process.env.MEDUSA_BACKEND_URL,
            redirectUrl: process.env.SUMUP_REDIRECT_URL,
          },
        },
      ],
    },
  },
]
```

### Configuration Options

| Option | Description | Required | Default |
|---|---|---|---|
| `apiKey` | Your SumUp API key (e.g. `sup_sk_...`) | ✅ | — |
| `merchantCode` | Your SumUp merchant code (e.g. `MXXXXXXX`) | ✅ | — |
| `medusaUrl` | The public URL of your Medusa backend | ✅ | — |
| `redirectUrl` | The storefront URL to redirect the customer to after payment | ✅ | — |
| `debug` | Enable verbose debug logging | ❌ | `false` |

### Environment Variables

Add the following to your `.env` file:

```env
SUMUP_API_KEY=sup_sk_your_api_key
SUMUP_MERCHANT_CODE=YOUR_MERCHANT_CODE
MEDUSA_BACKEND_URL=https://your-medusa-server.com
SUMUP_REDIRECT_URL=https://your-store.com/checkout/payment
```

## Usage

Once installed and configured, the SumUp payment method will be available in your Medusa Admin. To enable it:

1. Log in to your Medusa Admin
2. Go to **Settings → Regions**
3. Add or edit a region and select **SumUp** from the payment providers dropdown

The provider ID for the SumUp checkout is:

```
pp_sumup_sumup
```

## Client-Side Integration

SumUp checkouts are created server-side by Medusa. After a payment session is initiated, the session data will contain a SumUp checkout `id` that you pass to the [SumUp Card Widget](https://developer.sumup.com/online-payments/tools/card-widget/) on your storefront to render the payment form.

Basic flow:

1. Customer reaches the payment step — Medusa creates a SumUp checkout via `initiatePayment`
2. Your storefront receives the checkout `id` from the payment session data
3. Render the SumUp Card Widget with the checkout ID
4. SumUp processes the payment and calls the Medusa webhook (`/hooks/payment/sumup_sumup`)
5. Medusa authorizes and captures the payment automatically

Example Card Widget integration:

```html
<script src="https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js"></script>
<div id="sumup-card"></div>

<script>
  SumUpCard.mount({
    checkoutId: "<checkout-id-from-session-data>",
    onResponse: function (type, body) {
      if (type === "success") {
        // Redirect or poll for order completion
      }
    },
  });
</script>
```

For APMs (iDEAL, Bancontact, etc.), the `redirectUrl` option handles the post-payment redirect automatically.

## License

MIT
