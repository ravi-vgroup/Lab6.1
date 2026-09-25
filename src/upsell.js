import { shopifyGraphQL } from "./shopify.js";

const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const MAX_SUGGESTIONS = 3;

export function normalizeProductId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return `gid://shopify/Product/${text}`;
  const match = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(text);
  return match ? text : null;
}

/**
 * Pure co-purchase scoring. pastOrders: [{ lineItems: [{ productId, title }] }].
 * For every order containing at least one cart product, each OTHER product in that
 * order scores one co-occurrence (once per order, however many lines/units). Cart
 * products are never candidates. Sorted by count, highest first (ties by title).
 * Returns [{ productId, title, count, boughtWith: [cart product titles] }].
 */
export function scoreUpsellCandidates(pastOrders, cartProductIds) {
  const cart = new Set(cartProductIds);
  const candidates = new Map();

  for (const order of pastOrders) {
    // Line items without a product (deleted or custom items) can't be matched or recommended.
    const items = (order.lineItems ?? []).filter((item) => item.productId);
    const cartItemsInOrder = items.filter((item) => cart.has(item.productId));
    if (cartItemsInOrder.length === 0) continue;

    const seen = new Set();
    for (const item of items) {
      if (cart.has(item.productId) || seen.has(item.productId)) continue;
      seen.add(item.productId);

      const entry = candidates.get(item.productId) ?? {
        productId: item.productId,
        title: item.title,
        count: 0,
        boughtWith: new Set(),
      };
      entry.count += 1;
      for (const cartItem of cartItemsInOrder) entry.boughtWith.add(cartItem.title);
      candidates.set(item.productId, entry);
    }
  }

  return [...candidates.values()]
    .map((entry) => ({ ...entry, boughtWith: [...entry.boughtWith].sort() }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function joinTitles(titles) {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

/** One-line reason for a scored candidate. */
export function upsellReason(candidate) {
  const times = candidate.count === 1 ? "1 past order" : `${candidate.count} past orders`;
  return `Customers who bought ${joinTitles(candidate.boughtWith)} also bought ${candidate.title} (${times}).`;
}

// Recent non-cancelled orders' line items. Only order line items are read, so this
// needs read_orders; no customer fields are queried.
async function fetchRecentOrders() {
  const orders = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shopifyGraphQL(
      `
      query UpsellOrders($after: String) {
        orders(first: ${PAGE_SIZE}, after: $after, sortKey: CREATED_AT, reverse: true) {
          nodes {
            cancelledAt
            lineItems(first: 100) { nodes { title product { id } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      `,
      { after: cursor },
    );

    for (const order of data.orders.nodes) {
      if (order.cancelledAt) continue;
      orders.push({
        lineItems: order.lineItems.nodes.map((item) => ({ productId: item.product?.id ?? null, title: item.title })),
      });
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }

  return orders;
}

/**
 * Fetch recent order history, score co-purchases for the cart, and return the
 * top 3 suggestions with a one-line reason each. An empty list means no history
 * supports a recommendation; never fill it with a guess.
 */
export async function recommendUpsell({ cartProductIds }) {
  const cart = cartProductIds.map((id) => ({ input: id, productId: normalizeProductId(id) }));
  const invalid = cart.filter((entry) => !entry.productId).map((entry) => entry.input);
  if (invalid.length) {
    throw new Error(`Not a Shopify product ID: ${invalid.join(", ")}. Use numeric IDs or gid://shopify/Product/<id>.`);
  }

  const orders = await fetchRecentOrders();
  const cartIds = [...new Set(cart.map((entry) => entry.productId))];
  const scored = scoreUpsellCandidates(orders, cartIds);
  const ordersWithCartItems = orders.filter((order) => order.lineItems.some((item) => cartIds.includes(item.productId))).length;

  const suggestions = scored.slice(0, MAX_SUGGESTIONS).map((candidate) => ({
    productId: candidate.productId,
    title: candidate.title,
    coPurchaseCount: candidate.count,
    reason: upsellReason(candidate),
  }));

  return {
    cartProductIds: cartIds,
    ordersAnalyzed: orders.length,
    ordersContainingCartItems: ordersWithCartItems,
    suggestions,
    ...(suggestions.length === 0
      ? {
          message:
            ordersWithCartItems === 0
              ? "No recent orders contain these cart products, so there is no co-purchase history to recommend from."
              : "Past orders with these cart products contained no other products, so there is nothing to recommend.",
        }
      : {}),
  };
}
