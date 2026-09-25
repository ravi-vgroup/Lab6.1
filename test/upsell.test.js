import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProductId, scoreUpsellCandidates, upsellReason } from "../src/upsell.js";

// Plain arrays only: no real order data or network involved.
const order = (...ids) => ({ lineItems: ids.map((id) => ({ productId: id, title: `Product ${id}` })) });

const BOARD = "board";
const WAX = "wax";
const GLOVES = "gloves";
const HELMET = "helmet";
const GOGGLES = "goggles";

const HISTORY = [
  order(BOARD, WAX),
  order(BOARD, WAX, GLOVES),
  order(BOARD, WAX),
  order(BOARD, HELMET),
  order(GOGGLES, HELMET), // no cart item: must not count toward anything
];

test("the most frequently co-purchased item ranks first", () => {
  const ranked = scoreUpsellCandidates(HISTORY, [BOARD]);
  assert.deepEqual(
    ranked.map((c) => [c.productId, c.count]),
    [
      [WAX, 3],
      [GLOVES, 1],
      [HELMET, 1],
    ],
  );
});

test("an item already in the cart is never recommended back", () => {
  const ranked = scoreUpsellCandidates(HISTORY, [BOARD, WAX]);
  const ids = ranked.map((c) => c.productId);
  assert.ok(!ids.includes(BOARD));
  assert.ok(!ids.includes(WAX));
  assert.deepEqual(ids, [GLOVES, HELMET]);
});

test("a cart item with no co-purchase history returns no candidates at all", () => {
  assert.deepEqual(scoreUpsellCandidates(HISTORY, ["never-ordered"]), []);
  // Bought before, but only ever on its own: still nothing to recommend.
  assert.deepEqual(scoreUpsellCandidates([order(BOARD), order(BOARD)], [BOARD]), []);
  assert.deepEqual(scoreUpsellCandidates([], [BOARD]), []);
});

test("orders without any cart product contribute nothing", () => {
  const ranked = scoreUpsellCandidates(HISTORY, [BOARD]);
  assert.ok(!ranked.some((c) => c.productId === GOGGLES));
  // Helmet appears in two orders, but only one of them contains the board.
  assert.equal(ranked.find((c) => c.productId === HELMET).count, 1);
});

test("a product counts once per order, even on repeated lines", () => {
  const ranked = scoreUpsellCandidates([order(BOARD, WAX, WAX, WAX)], [BOARD]);
  assert.deepEqual(ranked.map((c) => [c.productId, c.count]), [[WAX, 1]]);
});

test("line items without a product are skipped", () => {
  const history = [{ lineItems: [{ productId: BOARD, title: "Board" }, { productId: null, title: "Custom engraving" }] }];
  assert.deepEqual(scoreUpsellCandidates(history, [BOARD]), []);
});

test("candidates record which cart items they were bought with, for the reason line", () => {
  const history = [order(BOARD, WAX), order(GLOVES, WAX)];
  const [wax] = scoreUpsellCandidates(history, [BOARD, GLOVES]);
  assert.equal(wax.count, 2);
  assert.deepEqual(wax.boughtWith, ["Product board", "Product gloves"]);
  assert.equal(
    upsellReason(wax),
    "Customers who bought Product board and Product gloves also bought Product wax (2 past orders).",
  );
});

test("ties break alphabetically so results are stable", () => {
  const ranked = scoreUpsellCandidates([order(BOARD, HELMET, GLOVES)], [BOARD]);
  assert.deepEqual(ranked.map((c) => c.productId), [GLOVES, HELMET]);
});

test("normalizeProductId accepts numeric and gid IDs only", () => {
  assert.equal(normalizeProductId("123"), "gid://shopify/Product/123");
  assert.equal(normalizeProductId(" gid://shopify/Product/9 "), "gid://shopify/Product/9");
  assert.equal(normalizeProductId("gid://shopify/Product/9"), "gid://shopify/Product/9");
  assert.equal(normalizeProductId("gid://shopify/Order/9"), null);
  assert.equal(normalizeProductId("Snowboard"), null);
});
