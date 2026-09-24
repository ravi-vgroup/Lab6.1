import test from "node:test";
import assert from "node:assert/strict";

import { requireApproval } from "../src/approval.js";
import {
  getOrderDetails,
  pickProductMatch,
  pickLocationMatch,
  shouldAutoConfirm,
} from "../src/tools.js";
import { triggerFlow } from "../src/flow.js";


// ============================================================
// Approval Gate Tests — 5 cases
// ============================================================

test("shopper + confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "shopper",
        confirmed: true,
      }),
    /must be admin or staff/
  );
});

test("admin + not confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "admin",
        confirmed: false,
      }),
    /explicit confirmation is required/
  );
});

test("staff + not confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "staff",
        confirmed: false,
      }),
    /explicit confirmation is required/
  );
});

test("admin + confirmed passes", () => {
  assert.equal(
    requireApproval({
      role: "admin",
      confirmed: true,
    }),
    true
  );
});

test("staff + confirmed passes", () => {
  assert.equal(
    requireApproval({
      role: "staff",
      confirmed: true,
    }),
    true
  );
});


// ============================================================
// Product Name Matching Tests — 4 cases
// ============================================================

test("product exact match wins", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "Snowboard Boots" },
  ];

  const result = pickProductMatch(products, "Snowboard");

  assert.equal(result.id, "1");
});

test("product substring match works when there is one match", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "T-Shirt" },
  ];

  const result = pickProductMatch(products, "snow");

  assert.equal(result.id, "1");
});

test("product with no match is rejected", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "T-Shirt" },
  ];

  assert.throws(
    () => pickProductMatch(products, "Laptop"),
    /No product found/
  );
});

test("ambiguous product match is rejected", () => {
  const products = [
    { id: "1", title: "Snowboard Red" },
    { id: "2", title: "Snowboard Blue" },
  ];

  assert.throws(
    () => pickProductMatch(products, "Snowboard"),
    /Multiple products found/
  );
});


// ============================================================
// Location Name Matching Tests — 4 cases
// ============================================================

test("location exact match wins", () => {
  const locations = [
    { id: "1", name: "Warehouse" },
    { id: "2", name: "Warehouse East" },
  ];

  const result = pickLocationMatch(locations, "Warehouse");

  assert.equal(result.id, "1");
});

test("location substring match works when there is one match", () => {
  const locations = [
    { id: "1", name: "Main Warehouse" },
    { id: "2", name: "Store" },
  ];

  const result = pickLocationMatch(locations, "Main");

  assert.equal(result.id, "1");
});

test("location with no match is rejected", () => {
  const locations = [
    { id: "1", name: "Warehouse" },
    { id: "2", name: "Store" },
  ];

  assert.throws(
    () => pickLocationMatch(locations, "Office"),
    /No location found/
  );
});

test("ambiguous location match is rejected", () => {
  const locations = [
    { id: "1", name: "Warehouse East" },
    { id: "2", name: "Warehouse West" },
  ];

  assert.throws(
    () => pickLocationMatch(locations, "Warehouse"),
    /Multiple locations found/
  );
});

test("location suggestions include available names", () => {
  const locations = [
    { id: "1", name: "Warehouse East" },
    { id: "2", name: "Main Store" },
  ];

  assert.throws(
    () => pickLocationMatch(locations, "Snow City Warehouse"),
    /Warehouse East|Main Store/
  );
});

test("getAccessToken prefers direct Shopify access token", async () => {
  const previous = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN,
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
  };

  try {
    process.env.SHOPIFY_STORE_DOMAIN = "demo-store.myshopify.com";
    process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test_token";
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;

    const moduleUrl = `../src/shopify.js?test=${Date.now()}`;
    const { getAccessToken } = await import(moduleUrl);
    let fetchCalled = false;

    global.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const token = await getAccessToken();

    assert.equal(token, "shpat_test_token");
    assert.equal(fetchCalled, false);
  } finally {
    if (previous.SHOPIFY_STORE_DOMAIN === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN = previous.SHOPIFY_STORE_DOMAIN;
    }

    if (previous.SHOPIFY_ACCESS_TOKEN === undefined) {
      delete process.env.SHOPIFY_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ACCESS_TOKEN = previous.SHOPIFY_ACCESS_TOKEN;
    }

    if (previous.SHOPIFY_CLIENT_ID === undefined) {
      delete process.env.SHOPIFY_CLIENT_ID;
    } else {
      process.env.SHOPIFY_CLIENT_ID = previous.SHOPIFY_CLIENT_ID;
    }

    if (previous.SHOPIFY_CLIENT_SECRET === undefined) {
      delete process.env.SHOPIFY_CLIENT_SECRET;
    } else {
      process.env.SHOPIFY_CLIENT_SECRET = previous.SHOPIFY_CLIENT_SECRET;
    }
  }
});

test("updateOrderStatus converts numeric order IDs to Shopify GraphQL global IDs", async () => {
  const previousDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const previousToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const originalFetch = global.fetch;

  process.env.SHOPIFY_STORE_DOMAIN = "demo-store.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "shpat_demo";

  try {
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.variables.id, "gid://shopify/Order/7183570567204");

      return {
        ok: true,
        json: async () => ({
          data: {
            orderClose: {
              order: {
                id: "gid://shopify/Order/7183570567204",
                name: "#1001",
                closed: true,
                cancelledAt: null,
              },
              userErrors: [],
            },
          },
        }),
      };
    };

    const result = await import("../src/tools.js").then(({ updateOrderStatus }) =>
      updateOrderStatus({
        orderId: "7183570567204",
        action: "close",
        role: "admin",
        confirmed: true,
      })
    );

    assert.equal(result.orderId, "gid://shopify/Order/7183570567204");
  } finally {
    global.fetch = originalFetch;

    if (previousDomain === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN = previousDomain;
    }

    if (previousToken === undefined) {
      delete process.env.SHOPIFY_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ACCESS_TOKEN = previousToken;
    }
  }
});

test("triggerFlow posts to Shopify Flow custom trigger handle", async () => {
  const previousDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const previousToken = process.env.SHOPIFY_ACCESS_TOKEN;

  process.env.SHOPIFY_STORE_DOMAIN = "demo-store.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "shpat_demo";

  const originalFetch = global.fetch;

  try {
    let called = false;
    global.fetch = async (_url, options) => {
      called = true;
      const body = JSON.parse(options.body);

      assert.equal(body.variables.handle, "order-review-requested");
      assert.deepEqual(body.variables.payload, {
        order_id: "7183570567204",
        reason: "high-risk",
      });

      return {
        ok: true,
        json: async () => ({
          data: {
            flowTriggerReceive: {
              userErrors: [],
            },
          },
        }),
      };
    };

    const result = await triggerFlow({
      handle: "order-review-requested",
      payload: {
        order_id: "7183570567204",
        reason: "high-risk",
      },
    });

    assert.equal(called, true);
    assert.deepEqual(result.userErrors, []);
  } finally {
    global.fetch = originalFetch;

    if (previousDomain === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN = previousDomain;
    }

    if (previousToken === undefined) {
      delete process.env.SHOPIFY_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ACCESS_TOKEN = previousToken;
    }
  }
});

test("shouldAutoConfirm auto-confirms LOW and blocks MEDIUM/HIGH", () => {
  assert.deepEqual(shouldAutoConfirm("LOW"), {
    autoConfirm: true,
    reason: null,
  });

  assert.deepEqual(shouldAutoConfirm("MEDIUM"), {
    autoConfirm: false,
    reason: "flagged for manual review",
  });

  assert.deepEqual(shouldAutoConfirm("HIGH"), {
    autoConfirm: false,
    reason: "held - high risk",
  });

  assert.throws(
    () => shouldAutoConfirm("CRITICAL"),
    /Unrecognized risk level/
  );
});

test("getOrderDetails normalizes numeric order IDs and returns order fields", async () => {
  const previousDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const previousToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const originalFetch = global.fetch;

  process.env.SHOPIFY_STORE_DOMAIN = "demo-store.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "shpat_demo";

  try {
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.variables.id, "gid://shopify/Order/7183570010148");

      return {
        ok: true,
        json: async () => ({
          data: {
            order: {
              id: "gid://shopify/Order/7183570010148",
              name: "#1002",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              totalPrice: "100.00",
              subtotalPrice: "100.00",
              totalTax: "0.00",
              currencyCode: "USD",
              customer: {
                firstName: "Amit",
                lastName: "Patel",
                email: "amit@example.com",
              },
              lineItems: {
                nodes: [
                  {
                    title: "Snowboard",
                    quantity: 1,
                    originalTotalPrice: "100.00",
                    variant: { id: "gid://shopify/ProductVariant/123", title: "Default Title" },
                  },
                ],
              },
            },
          },
        }),
      };
    };

    const result = await getOrderDetails({ orderId: "7183570010148" });

    assert.equal(result.id, "gid://shopify/Order/7183570010148");
    assert.equal(result.name, "#1002");
    assert.equal(result.customer.email, "amit@example.com");
    assert.equal(result.lineItems[0].title, "Snowboard");
  } finally {
    global.fetch = originalFetch;

    if (previousDomain === undefined) {
      delete process.env.SHOPIFY_STORE_DOMAIN;
    } else {
      process.env.SHOPIFY_STORE_DOMAIN = previousDomain;
    }

    if (previousToken === undefined) {
      delete process.env.SHOPIFY_ACCESS_TOKEN;
    } else {
      process.env.SHOPIFY_ACCESS_TOKEN = previousToken;
    }
  }
});