import "dotenv/config";

let cachedToken = null;
let tokenExpiresAt = 0;

function getShopifyEnv() {
  return {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN,
    SHOPIFY_AUTH_CODE: process.env.SHOPIFY_AUTH_CODE,
  };
}

/**
 * Shopify supports two valid admin auth patterns:
 * 1) a direct access token (for custom/private apps), or
 * 2) an OAuth authorization code exchange using client_id + client_secret.
 *
 * The previous client_credentials flow is not valid for the admin OAuth endpoint
 * and causes the exact "Missing or invalid client secret" failure seen here.
 */
export async function getAccessToken() {
  const {
    SHOPIFY_STORE_DOMAIN,
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET,
    SHOPIFY_ACCESS_TOKEN,
    SHOPIFY_AUTH_CODE,
  } = getShopifyEnv();

  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in .env");
  }

  // Prefer a direct access token when it is configured; this avoids the OAuth exchange.
  if (SHOPIFY_ACCESS_TOKEN) {
    cachedToken = SHOPIFY_ACCESS_TOKEN;
    tokenExpiresAt = Number.MAX_SAFE_INTEGER;
    return cachedToken;
  }

  if (!SHOPIFY_CLIENT_ID) {
    throw new Error("Missing SHOPIFY_CLIENT_ID in .env");
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing SHOPIFY_CLIENT_SECRET in .env");
  }

  if (!SHOPIFY_AUTH_CODE) {
    throw new Error(
      "Missing SHOPIFY_AUTH_CODE in .env. Set SHOPIFY_ACCESS_TOKEN for a direct token or provide the OAuth authorization code."
    );
  }

  // Reuse cached token until shortly before expiry
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code: SHOPIFY_AUTH_CODE,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Shopify token request failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;

  return cachedToken;
}

/**
 * Execute a Shopify Admin GraphQL query.
 */
export async function shopifyGraphQL(query, variables = {}) {
  const { SHOPIFY_STORE_DOMAIN } = getShopifyEnv();

  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in .env");
  }

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getAccessToken(),
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Shopify GraphQL request failed: ${response.status} ${errorText}`
    );
  }

  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${JSON.stringify(result.errors)}`
    );
  }

  return result.data;
}