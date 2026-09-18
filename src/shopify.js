import "dotenv/config";

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
} = process.env;

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get Shopify Admin API access token using
 * OAuth client_credentials grant.
 */
export async function getAccessToken() {
  // Validate env when the client is actually used (avoid throwing at import time)
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in .env");
  }

  if (!SHOPIFY_CLIENT_ID) {
    throw new Error("Missing SHOPIFY_CLIENT_ID in .env");
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing SHOPIFY_CLIENT_SECRET in .env");
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
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
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
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

/**
 * Execute a Shopify Admin GraphQL query.
 */
export async function shopifyGraphQL(query, variables = {}) {
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