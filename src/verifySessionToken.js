import crypto from "node:crypto";

// Allowed clock skew between Shopify and this server, in seconds.
const CLOCK_SKEW_SECONDS = 5;

function base64UrlDecode(segment) {
  return Buffer.from(segment, "base64url");
}

function parseJsonSegment(segment, label) {
  try {
    return JSON.parse(base64UrlDecode(segment).toString("utf8"));
  } catch {
    throw new Error(`Malformed session token ${label}.`);
  }
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verify a Shopify App Bridge session token (an HS256 JWT signed with the
 * app's client secret). Returns the decoded payload, or throws on any failure.
 */
export function verifySessionToken(token, { clientId, clientSecret, shopDomain, now = Date.now() }) {
  if (!clientId || !clientSecret || !shopDomain) {
    throw new Error("Session token verification is not configured.");
  }

  if (typeof token !== "string" || !token) {
    throw new Error("Missing session token.");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed session token.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonSegment(encodedHeader, "header");

  if (header.alg !== "HS256") {
    throw new Error("Unexpected session token algorithm.");
  }

  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = base64UrlDecode(encodedSignature);

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("Invalid session token signature.");
  }

  const payload = parseJsonSegment(encodedPayload, "payload");
  const nowSeconds = Math.floor(now / 1000);

  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new Error("Session token has expired.");
  }

  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new Error("Session token is not yet valid.");
  }

  if (payload.aud !== clientId) {
    throw new Error("Session token audience does not match this app.");
  }

  const expectedShop = shopDomain.toLowerCase();
  if (hostnameOf(payload.dest) !== expectedShop) {
    throw new Error("Session token destination does not match the shop.");
  }

  if (payload.iss !== undefined && hostnameOf(payload.iss) !== expectedShop) {
    throw new Error("Session token issuer does not match the shop.");
  }

  return payload;
}
