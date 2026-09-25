import { buildXlsx, STYLE } from "./xlsx.js";

const header = (...labels) => labels.map((value) => ({ value, style: STYLE.header }));
const money = (value) => (value === null || value === undefined ? "n/a" : { value, style: STYLE.money });
const integer = (value) => ({ value, style: STYLE.integer });
const bold = (value) => ({ value, style: STYLE.bold });
const muted = (value) => ({ value, style: STYLE.muted });

function percentChange(current, previous) {
  if (!previous) return "n/a";
  return { value: (current - previous) / previous, style: STYLE.percent };
}

function orderRows(orders) {
  return orders
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((order) => [
      order.name,
      order.createdAt.replace("T", " ").replace("Z", ""),
      order.lineItems.map((item) => `${item.title} × ${item.quantity ?? 1}`).join(", "),
      integer(order.lineItems.reduce((sum, item) => sum + Number(item.quantity ?? 1), 0)),
      money(order.totalPrice),
      order.currencyCode,
    ]);
}

export function salesReportFilename({ currentPeriod }) {
  return `sales-report_${currentPeriod.startDate}_to_${currentPeriod.endDate}.xlsx`;
}

/** Build the .xlsx workbook for a report from loadSalesReport(). Pure: no network. */
export function buildSalesWorkbook(report, { storeDomain = "", generatedAt = new Date() } = {}) {
  const { summary, products, currentOrders, previousOrders } = report;
  const currency = Array.isArray(summary.currency) ? summary.currency.join("/") : summary.currency || "";
  const cur = summary.currentPeriod;
  const prev = summary.previousPeriod;
  const totalOrders = summary.orderCount || 0;

  const summaryRows = [
    [{ value: "Sales report", style: STYLE.title }],
    [muted(`${storeDomain ? `${storeDomain} · ` : ""}Generated ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC · All dates UTC`)],
    [],
    header("Metric", "Current period", "Previous period", "Change"),
    [bold("Period"), `${cur.startDate} → ${cur.endDate}`, `${prev.startDate} → ${prev.endDate}`, ""],
    [bold("Orders"), integer(summary.orderCount), integer(summary.previousOrderCount), percentChange(summary.orderCount, summary.previousOrderCount)],
    [
      bold(`Revenue${currency ? ` (${currency})` : ""}`),
      money(summary.totalRevenue),
      money(summary.previousRevenue),
      summary.revenueChangePercent === null ? "n/a" : { value: summary.revenueChangePercent / 100, style: STYLE.percent },
    ],
    [
      bold(`Average order value${currency ? ` (${currency})` : ""}`),
      money(summary.averageOrderValue),
      money(summary.previousAverageOrderValue),
      percentChange(summary.averageOrderValue ?? 0, summary.previousAverageOrderValue ?? 0),
    ],
    [],
  ];
  if (summary.revenueChangePercent === null) {
    summaryRows.push([muted("The previous period had no revenue, so a percentage change can't be computed.")]);
  }
  if (summary.warning) {
    summaryRows.push([muted(summary.warning)]);
  }

  return buildXlsx([
    { name: "Summary", rows: summaryRows, columnWidths: [30, 26, 26, 14] },
    {
      name: "Top products",
      freezeRow: 1,
      columnWidths: [8, 44, 12, 12, 16],
      rows: [
        header("Rank", "Product", "Orders", "Units", "% of orders"),
        ...products.map((product, i) => [
          integer(i + 1),
          product.title,
          integer(product.orderCount),
          integer(product.units),
          totalOrders ? { value: product.orderCount / totalOrders, style: STYLE.share } : "n/a",
        ]),
      ],
    },
    {
      name: "Orders",
      freezeRow: 1,
      columnWidths: [12, 20, 60, 8, 14, 10],
      rows: [header("Order", "Created (UTC)", "Items", "Units", "Total", "Currency"), ...orderRows(currentOrders)],
    },
    {
      name: "Previous period orders",
      freezeRow: 1,
      columnWidths: [12, 20, 60, 8, 14, 10],
      rows: [header("Order", "Created (UTC)", "Items", "Units", "Total", "Currency"), ...orderRows(previousOrders)],
    },
  ]);
}
