import { shopifyGraphQL } from "./shopify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const MAX_RANGE_DAYS = 366;

// Sum money in integer cents so 0.1 + 0.2 style float drift can't creep into totals.
function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Pure ranking of every product by the number of orders containing it (an order
 * with 5 of an item counts once), with units summed from line-item quantities.
 * Ties break alphabetically. Returns [{ title, orderCount, units }].
 */
export function rankProducts(orders) {
  const products = new Map();
  for (const order of orders) {
    const seenInOrder = new Set();
    for (const item of order.lineItems ?? []) {
      const key = item.productId ?? item.title;
      const entry = products.get(key) ?? { title: item.title, orderCount: 0, units: 0 };
      entry.units += Number(item.quantity ?? 1);
      if (!seenInOrder.has(key)) {
        seenInOrder.add(key);
        entry.orderCount += 1;
      }
      products.set(key, entry);
    }
  }

  return [...products.values()].sort((a, b) => b.orderCount - a.orderCount || a.title.localeCompare(b.title));
}

function averageCents(totalCents, count) {
  return count === 0 ? null : Math.round(totalCents / count) / 100;
}

/**
 * Pure sales summary. Orders are { totalPrice: number, lineItems: [{ productId?, title, quantity? }] }.
 * Returns current revenue, % change vs the previous period (null when the previous
 * revenue is zero), and the top 3 products by number of orders containing them.
 */
export function computeSalesSummary(currentOrders, previousOrders) {
  const revenueCents = currentOrders.reduce((sum, order) => sum + toCents(order.totalPrice), 0);
  const previousRevenueCents = previousOrders.reduce((sum, order) => sum + toCents(order.totalPrice), 0);

  const revenueChangePercent =
    previousRevenueCents === 0
      ? null
      : Math.round(((revenueCents - previousRevenueCents) / previousRevenueCents) * 10000) / 100;

  const topProducts = rankProducts(currentOrders)
    .slice(0, 3)
    .map(({ title, orderCount }) => ({ title, orderCount }));

  return {
    orderCount: currentOrders.length,
    totalRevenue: revenueCents / 100,
    averageOrderValue: averageCents(revenueCents, currentOrders.length),
    previousOrderCount: previousOrders.length,
    previousRevenue: previousRevenueCents / 100,
    previousAverageOrderValue: averageCents(previousRevenueCents, previousOrders.length),
    revenueChangePercent,
    topProducts,
  };
}

/**
 * Resolve the requested range (inclusive YYYY-MM-DD dates, UTC) and the prior
 * range of equal length ending the day before it starts.
 */
export function resolvePeriods({ startDate, endDate, days, today = new Date() }) {
  let start;
  let end;

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      throw new Error("Provide both startDate and endDate, or use days.");
    }
    start = new Date(`${startDate}T00:00:00Z`);
    end = new Date(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error("Dates must be in YYYY-MM-DD format.");
    }
    if (end < start) {
      throw new Error("endDate must be on or after startDate.");
    }
  } else {
    const count = days ?? 30;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("days must be a positive integer.");
    }
    end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    start = new Date(end.getTime() - (count - 1) * DAY_MS);
  }

  const lengthDays = Math.round((end - start) / DAY_MS) + 1;
  if (lengthDays > MAX_RANGE_DAYS) {
    throw new Error(`Date range can be at most ${MAX_RANGE_DAYS} days.`);
  }
  const previousEnd = new Date(start.getTime() - DAY_MS);
  const previousStart = new Date(previousEnd.getTime() - (lengthDays - 1) * DAY_MS);
  const iso = (date) => date.toISOString().slice(0, 10);

  return {
    lengthDays,
    current: { startDate: iso(start), endDate: iso(end) },
    previous: { startDate: iso(previousStart), endDate: iso(previousEnd) },
  };
}

// Fetch non-cancelled orders created within [startDate, endDate] (inclusive, UTC).
async function fetchOrders({ startDate, endDate }) {
  const endExclusive = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + DAY_MS).toISOString();
  const search = `created_at:>='${startDate}T00:00:00Z' AND created_at:<'${endExclusive}'`;

  const orders = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shopifyGraphQL(
      `
      query SalesOrders($query: String!, $after: String) {
        orders(first: ${PAGE_SIZE}, after: $after, query: $query) {
          nodes {
            name
            createdAt
            cancelledAt
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 100) { nodes { title quantity product { id } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      `,
      { query: search, after: cursor },
    );

    for (const order of data.orders.nodes) {
      if (order.cancelledAt) continue;
      orders.push({
        name: order.name,
        createdAt: order.createdAt,
        totalPrice: Number(order.currentTotalPriceSet.shopMoney.amount),
        currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
        lineItems: order.lineItems.nodes.map((item) => ({
          productId: item.product?.id ?? null,
          title: item.title,
          quantity: item.quantity,
        })),
      });
    }

    if (!data.orders.pageInfo.hasNextPage) {
      return { orders, truncated: false };
    }
    cursor = data.orders.pageInfo.endCursor;
  }

  return { orders, truncated: true };
}

/**
 * Fetch real orders for the range and the equivalent prior range. The agent tool,
 * the dashboard and the Excel export all build on this, so their numbers agree.
 */
export async function loadSalesReport({ startDate, endDate, days } = {}) {
  const periods = resolvePeriods({ startDate, endDate, days });
  const [current, previous] = await Promise.all([fetchOrders(periods.current), fetchOrders(periods.previous)]);

  const currencies = new Set([...current.orders, ...previous.orders].map((order) => order.currencyCode));
  const truncated = current.truncated || previous.truncated;

  return {
    summary: {
      currentPeriod: periods.current,
      previousPeriod: periods.previous,
      timezone: "UTC",
      currency: currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? null : [...currencies],
      ...computeSalesSummary(current.orders, previous.orders),
      ...(truncated
        ? { warning: `More than ${PAGE_SIZE * MAX_PAGES} orders in a period; totals cover only the first ${PAGE_SIZE * MAX_PAGES}.` }
        : {}),
    },
    products: rankProducts(current.orders),
    currentOrders: current.orders,
    previousOrders: previous.orders,
  };
}

/** Fetch real orders for the range and the equivalent prior range, then summarize them. */
export async function getSalesSummary(range = {}) {
  return (await loadSalesReport(range)).summary;
}
