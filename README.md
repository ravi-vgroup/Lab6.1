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

Store policy search (RAG)

- At startup the store's policy pages (Admin API `shop.shopPolicies`) and product descriptions are chunked (`src/rag/chunk.js`), embedded once with Voyage AI (`src/rag/embed.js`, needs `VOYAGE_API_KEY`), and held in memory.
- The `search_store_policies` tool embeds the question with the same function, ranks chunks by cosine similarity (`src/rag/similarity.js`), and returns the top 3 that score at least `RAG_MIN_SCORE` (default 0.45). Below that it returns `found: false` and the agent says the policies don't cover it instead of guessing.
- `test/rag.test.js` covers chunking, the ranking math, and the threshold behaviour with synthetic vectors and a fake embedder — no network calls.
- A Voyage account without a payment method is limited to 3 requests/minute; `embedTexts` waits and retries on 429.

Sales analytics

- `get_sales_summary` takes `startDate`+`endDate` (YYYY-MM-DD, inclusive, UTC) or `days` (last N days including today, default 30), fetches non-cancelled orders for that range and the equal-length prior range via the Admin API, and passes them to `computeSalesSummary` in `src/sales.js`.
- `computeSalesSummary(currentOrders, previousOrders)` is pure: order count, total revenue (summed in cents), % change vs the prior period (`null` when the prior revenue is zero), and the top 3 products by number of orders. The agent only restates these numbers; it never estimates them.
- `test/sales.test.js` covers it with plain arrays, no order data or network.
- Without the `read_all_orders` scope the Admin API only returns the last 60 days of orders.

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
