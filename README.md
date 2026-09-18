# Shopify Ops Agent (Claude Agent SDK)

This project provides a small operations agent that exposes two tools via an MCP server:

- `check_inventory_level` (read-only): resolve product and location by name and return inventory per variant.
- `update_order_status` (write): close, reopen, or cancel orders. Requires approval (role `admin` or `staff` AND `confirmed: true`).

Setup

1. Copy `.env.example` to `.env` and fill in `SHOPIFY_*` values.
2. Install dependencies: `npm install`.
3. Run tests: `npm test` (uses `node --test`).
4. Run the CLI: `npm start`.

Notes

- The Shopify client exchanges `client_id`/`client_secret` for an access token and caches it in memory until shortly before expiry.
- Name-matching (product/location) is separated from network calls and covered by unit tests.
- The agent explicitly allows only the two tools listed; no other built-in tools are exposed.
