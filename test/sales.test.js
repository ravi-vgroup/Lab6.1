import test from "node:test";
import assert from "node:assert/strict";

import { computeSalesSummary, resolvePeriods } from "../src/sales.js";

// Plain arrays only: no real order data or network involved.
const order = (totalPrice, ...titles) => ({
  totalPrice,
  lineItems: titles.map((title) => ({ productId: `p:${title}`, title })),
});

// ============================================================
// computeSalesSummary
// ============================================================

test("order count and revenue sum correctly", () => {
  const current = [order(10.5, "A"), order(20.25, "B"), order(0.1, "C"), order(0.2, "A")];
  const summary = computeSalesSummary(current, []);

  assert.equal(summary.orderCount, 4);
  assert.equal(summary.totalRevenue, 31.05);
  assert.equal(summary.previousOrderCount, 0);
  assert.equal(summary.previousRevenue, 0);
});

test("money sums without floating-point drift", () => {
  const summary = computeSalesSummary([order(0.1, "A"), order(0.2, "B")], [order(0.3, "A")]);
  assert.equal(summary.totalRevenue, 0.3);
  assert.equal(summary.revenueChangePercent, 0);
});

test("revenue increase computes the correct positive percentage", () => {
  const summary = computeSalesSummary([order(100, "A"), order(50, "B")], [order(80, "A"), order(20, "B")]);
  assert.equal(summary.totalRevenue, 150);
  assert.equal(summary.previousRevenue, 100);
  assert.equal(summary.revenueChangePercent, 50);
});

test("revenue decrease computes a negative percentage, rounded to 2 decimals", () => {
  assert.equal(computeSalesSummary([order(75, "A")], [order(100, "A")]).revenueChangePercent, -25);
  assert.equal(computeSalesSummary([order(100, "A")], [order(30, "A")]).revenueChangePercent, 233.33);
});

test("most frequently ordered product ranks first", () => {
  const current = [
    order(10, "Snowboard", "Wax"),
    order(10, "Snowboard"),
    order(10, "Snowboard", "Gloves"),
    order(10, "Wax"),
    order(10, "Helmet"),
  ];
  const { topProducts } = computeSalesSummary(current, []);

  assert.equal(topProducts.length, 3);
  assert.deepEqual(topProducts[0], { title: "Snowboard", orderCount: 3 });
  assert.deepEqual(topProducts[1], { title: "Wax", orderCount: 2 });
  // Gloves and Helmet tie on 1; ties break alphabetically.
  assert.deepEqual(topProducts[2], { title: "Gloves", orderCount: 1 });
});

test("top products count orders, not units or repeated lines", () => {
  const current = [
    { totalPrice: 10, lineItems: [{ productId: "p1", title: "Board" }, { productId: "p1", title: "Board" }] },
    order(10, "Wax"),
    order(10, "Wax"),
  ];
  const { topProducts } = computeSalesSummary(current, []);
  assert.deepEqual(topProducts, [
    { title: "Wax", orderCount: 2 },
    { title: "Board", orderCount: 1 },
  ]);
});

test("zero-revenue previous period reports null instead of a nonsensical percentage", () => {
  const summary = computeSalesSummary([order(500, "A")], []);
  assert.equal(summary.revenueChangePercent, null);

  // Previous orders that exist but total zero (e.g. fully discounted) also give null.
  assert.equal(computeSalesSummary([order(500, "A")], [order(0, "A")]).revenueChangePercent, null);
});

test("empty current period gives zero revenue and no products", () => {
  const summary = computeSalesSummary([], [order(40, "A")]);
  assert.equal(summary.orderCount, 0);
  assert.equal(summary.totalRevenue, 0);
  assert.equal(summary.revenueChangePercent, -100);
  assert.deepEqual(summary.topProducts, []);
});

// ============================================================
// resolvePeriods — pure date math for the tool's prior range
// ============================================================

test("explicit range gets a prior range of equal length ending the day before", () => {
  const periods = resolvePeriods({ startDate: "2026-09-01", endDate: "2026-09-07" });
  assert.equal(periods.lengthDays, 7);
  assert.deepEqual(periods.current, { startDate: "2026-09-01", endDate: "2026-09-07" });
  assert.deepEqual(periods.previous, { startDate: "2026-08-25", endDate: "2026-08-31" });
});

test("days counts back from today inclusive", () => {
  const periods = resolvePeriods({ days: 7, today: new Date("2026-09-24T15:00:00Z") });
  assert.deepEqual(periods.current, { startDate: "2026-09-18", endDate: "2026-09-24" });
  assert.deepEqual(periods.previous, { startDate: "2026-09-11", endDate: "2026-09-17" });
});

test("invalid ranges throw", () => {
  assert.throws(() => resolvePeriods({ startDate: "2026-09-10", endDate: "2026-09-01" }), /on or after/);
  assert.throws(() => resolvePeriods({ startDate: "2026-09-10" }), /both/);
  assert.throws(() => resolvePeriods({ startDate: "nope", endDate: "2026-09-01" }), /YYYY-MM-DD/);
});
