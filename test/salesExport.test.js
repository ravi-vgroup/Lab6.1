import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { computeSalesSummary, rankProducts } from "../src/sales.js";
import { buildSalesWorkbook, salesReportFilename } from "../src/salesExport.js";
import { buildXlsx } from "../src/xlsx.js";

// Read every entry of a zip buffer by walking its local file headers.
function unzip(buffer) {
  const files = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    offset = start + compressedSize;
  }
  return files;
}

const order = (name, createdAt, totalPrice, ...items) => ({
  name,
  createdAt,
  totalPrice,
  currencyCode: "USD",
  lineItems: items.map(([title, quantity]) => ({ productId: `p:${title}`, title, quantity })),
});

const CURRENT = [
  order("#1002", "2026-09-20T10:00:00Z", 150, ["Snowboard", 2], ["Wax", 1]),
  order("#1001", "2026-09-19T09:00:00Z", 100, ["Snowboard", 1]),
  order("#1003", "2026-09-21T12:00:00Z", 50.5, ["Wax & <Polish>", 3]),
];
const PREVIOUS = [order("#0999", "2026-09-15T08:00:00Z", 200, ["Snowboard", 1])];

function report(current = CURRENT, previous = PREVIOUS) {
  return {
    summary: {
      currentPeriod: { startDate: "2026-09-19", endDate: "2026-09-25" },
      previousPeriod: { startDate: "2026-09-12", endDate: "2026-09-18" },
      currency: "USD",
      ...computeSalesSummary(current, previous),
    },
    products: rankProducts(current),
    currentOrders: current,
    previousOrders: previous,
  };
}

// ============================================================
// rankProducts / average order value
// ============================================================

test("rankProducts counts orders per product and sums units", () => {
  assert.deepEqual(rankProducts(CURRENT), [
    { title: "Snowboard", orderCount: 2, units: 3 },
    { title: "Wax", orderCount: 1, units: 1 },
    { title: "Wax & <Polish>", orderCount: 1, units: 3 },
  ]);
});

test("average order value is revenue / orders, and null with no orders", () => {
  const summary = computeSalesSummary(CURRENT, []);
  assert.equal(summary.averageOrderValue, 100.17);
  assert.equal(summary.previousAverageOrderValue, null);
});

// ============================================================
// xlsx container
// ============================================================

test("buildXlsx produces a zip with the required workbook parts", () => {
  const files = unzip(buildXlsx([{ name: "Data", rows: [["a", 1]] }]));
  for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(files[part], `missing ${part}`);
  }
  assert.match(files["xl/worksheets/sheet1.xml"], /<c r="A1" t="inlineStr"><is><t xml:space="preserve">a<\/t><\/is><\/c><c r="B1"><v>1<\/v><\/c>/);
});

test("buildXlsx escapes XML and sanitizes sheet names", () => {
  const files = unzip(buildXlsx([{ name: "Q3: [draft]/sales?", rows: [["<b>&\"x\""]] }]));
  assert.match(files["xl/worksheets/sheet1.xml"], /&lt;b&gt;&amp;&quot;x&quot;/);
  assert.match(files["xl/workbook.xml"], /name="Q3   draft  sales"/);
});

// ============================================================
// Sales workbook
// ============================================================

test("sales workbook has summary, products and both order sheets", () => {
  const files = unzip(buildSalesWorkbook(report(), { storeDomain: "shop.myshopify.com", generatedAt: new Date("2026-09-25T10:00:00Z") }));
  assert.match(files["xl/workbook.xml"], /name="Summary".*name="Top products".*name="Orders".*name="Previous period orders"/);

  const summarySheet = files["xl/worksheets/sheet1.xml"];
  assert.match(summarySheet, /Revenue \(USD\)/);
  assert.match(summarySheet, /<v>300\.5<\/v>/); // current revenue
  assert.match(summarySheet, /<v>200<\/v>/); // previous revenue
  assert.match(summarySheet, /<v>0\.5025<\/v>/); // +50.25% as a fraction
  assert.match(summarySheet, /shop\.myshopify\.com/);

  const productsSheet = files["xl/worksheets/sheet2.xml"];
  assert.match(productsSheet, /Snowboard/);
  assert.match(productsSheet, /Wax &amp; &lt;Polish&gt;/);

  // Orders are listed oldest first.
  const ordersSheet = files["xl/worksheets/sheet3.xml"];
  assert.ok(ordersSheet.indexOf("#1001") < ordersSheet.indexOf("#1002"));
  assert.match(files["xl/worksheets/sheet4.xml"], /#0999/);
});

test("zero-revenue previous period shows n/a and an explanation, not a number", () => {
  const files = unzip(buildSalesWorkbook(report(CURRENT, [])));
  const summarySheet = files["xl/worksheets/sheet1.xml"];
  assert.match(summarySheet, /n\/a/);
  assert.match(summarySheet, /no revenue/);
  assert.doesNotMatch(summarySheet, /Infinity|NaN/);
});

test("empty period still builds a valid workbook", () => {
  const files = unzip(buildSalesWorkbook(report([], [])));
  assert.match(files["xl/worksheets/sheet3.xml"], /Order/);
});

test("report filename uses the current period", () => {
  assert.equal(salesReportFilename(report().summary), "sales-report_2026-09-19_to_2026-09-25.xlsx");
});
