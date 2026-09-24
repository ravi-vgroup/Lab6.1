import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { verifySessionToken } from "../src/verifySessionToken.js";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const SHOP = "test-shop.myshopify.com";
const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;
const OPTIONS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, shopDomain: SHOP, now: NOW };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload, { secret = CLIENT_SECRET, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function validPayload(overrides = {}) {
  return {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: CLIENT_ID,
    sub: "42",
    exp: NOW_SECONDS + 60,
    nbf: NOW_SECONDS - 5,
    iat: NOW_SECONDS - 5,
    ...overrides,
  };
}

test("valid session token is accepted", () => {
  const payload = verifySessionToken(sign(validPayload()), OPTIONS);
  assert.equal(payload.sub, "42");
});

test("token signed with the wrong secret is rejected", () => {
  assert.throws(() => verifySessionToken(sign(validPayload(), { secret: "other" }), OPTIONS), /signature/);
});

test("tampered payload is rejected", () => {
  const [header, , signature] = sign(validPayload()).split(".");
  const forged = `${header}.${encode(validPayload({ sub: "1" }))}.${signature}`;
  assert.throws(() => verifySessionToken(forged, OPTIONS), /signature/);
});

test("non-HS256 algorithm is rejected", () => {
  const token = sign(validPayload(), { header: { alg: "none" } });
  assert.throws(() => verifySessionToken(token, OPTIONS), /algorithm/);
});

test("expired token is rejected", () => {
  assert.throws(() => verifySessionToken(sign(validPayload({ exp: NOW_SECONDS - 60 })), OPTIONS), /expired/);
});

test("token for another app is rejected", () => {
  assert.throws(() => verifySessionToken(sign(validPayload({ aud: "someone-else" })), OPTIONS), /audience/);
});

test("token for another shop is rejected", () => {
  const token = sign(validPayload({ dest: "https://evil.myshopify.com" }));
  assert.throws(() => verifySessionToken(token, OPTIONS), /destination/);
});

test("malformed and missing tokens are rejected", () => {
  assert.throws(() => verifySessionToken("", OPTIONS), /Missing/);
  assert.throws(() => verifySessionToken("a.b", OPTIONS), /Malformed/);
});

test("verification fails closed when not configured", () => {
  assert.throws(
    () => verifySessionToken(sign(validPayload()), { ...OPTIONS, clientSecret: "" }),
    /not configured/,
  );
});
