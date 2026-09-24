# Shopify Ops Agent (Claude Agent SDK)

This project provides a small operations agent that exposes two tools via an MCP server:

- `check_inventory_level` (read-only): resolve product and location by name and return inventory per variant.
- `update_order_status` (write): close, reopen, or cancel orders. Requires approval (role `admin` or `staff` AND `confirmed: true`).

Setup

1. Copy `.env.example` to `.env` and fill in `SHOPIFY_*` values.
2. Install dependencies: `npm install`.
3. Run tests: `npm test` (uses `node --test`).
4. Run the CLI: `npm start`.
5. Run the web chat UI:
   - `npm run ui` — embedded mode. Every API route requires a Shopify App Bridge session token, so the chat only works when opened from Shopify Admin (unauthenticated requests get 401).
   - `npm run ui:local` — for a plain local browser tab. Token-less requests from this machine (loopback only) are allowed; it refuses to start on Render. Use `PORT=3001` if 3000 is busy.

Notes

- Shopify admin auth is valid in two ways: either a direct `SHOPIFY_ACCESS_TOKEN` (common for custom/private apps), or a `SHOPIFY_AUTH_CODE` exchange using `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.
- The old `grant_type=client_credentials` request to `/admin/oauth/access_token` is not valid for Shopify admin OAuth and is the source of the `Missing or invalid client secret` error.
- Name-matching (product/location) is separated from network calls and covered by unit tests.
- The agent explicitly allows only the two tools listed; no other built-in tools are exposed.

Governed Flow action layer

- For writes that should be governed by a Shopify Flow workflow, the app exposes a `request_order_review` tool that calls the Shopify Admin GraphQL `flowTriggerReceive` mutation.
- The Flow trigger handle should match the deployed trigger extension, for example `order-review-requested`.
- This pattern is useful when you want validation, retries, and workflow controls to live in Shopify Flow rather than in your agent code.
- The trigger payload can carry simple fields like `order_id` and `reason`, which the workflow can inspect before performing the actual action.
