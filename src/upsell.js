import { shopifyGraphQL } from "./shopify.js";
import { pickProductMatch } from "./tools.js";

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

// Resolve each cart entry (a product ID or a product name) to { productId, title }.
async function resolveCart(cartProducts) {
  const ids = [];
  const names = [];
  for (const entry of cartProducts) {
    const id = normalizeProductId(entry);
    if (id) ids.push(id);
    else names.push(String(entry).trim());
  }

  const resolved = [];

  if (ids.length) {
    const data = await shopifyGraphQL(
      `query CartProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title } } }`,
      { ids },
    );
    const found = new Map(data.nodes.filter(Boolean).map((product) => [product.id, product.title]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new Error(`No product found with ID ${missing.map((id) => id.split("/").pop()).join(", ")}.`);
    }
    for (const id of ids) resolved.push({ productId: id, title: found.get(id) });
  }

  for (const name of names) {
    const data = await shopifyGraphQL(
      `query CartProductByName($query: String!) { products(first: 50, query: $query) { nodes { id title } } }`,
      { query: name },
    );
    const product = pickProductMatch(data.products.nodes, name);
    resolved.push({ productId: product.id, title: product.title });
  }

  // De-duplicate while keeping order.
  return [...new Map(resolved.map((item) => [item.productId, item])).values()];
}

/**
 * Fetch recent order history, score co-purchases for the cart, and return the
 * top 3 suggestions with a one-line reason each. An empty list means no history
 * supports a recommendation; never fill it with a guess.
 */
export async function recommendUpsell({ cartProducts }) {
  const [cart, orders] = await Promise.all([resolveCart(cartProducts), fetchRecentOrders()]);
  const cartIds = cart.map((item) => item.productId);
  const scored = scoreUpsellCandidates(orders, cartIds);

  const containing = (productId) => orders.filter((order) => order.lineItems.some((item) => item.productId === productId)).length;
  const ordersWithCartItems = orders.filter((order) => order.lineItems.some((item) => cartIds.includes(item.productId))).length;

  const suggestions = scored.slice(0, MAX_SUGGESTIONS).map((candidate) => ({
    productId: candidate.productId,
    title: candidate.title,
    coPurchaseCount: candidate.count,
    reason: upsellReason(candidate),
  }));

  let message;
  if (suggestions.length === 0) {
    const names = joinTitles(cart.map((item) => item.title));
    message =
      ordersWithCartItems === 0
        ? `${names} ${cart.length === 1 ? "hasn't" : "haven't"} been ordered in the last ${orders.length} orders, so there is no co-purchase history to recommend from.`
        : `${names} appeared in ${ordersWithCartItems} of the last ${orders.length} orders, but always on ${ordersWithCartItems === 1 ? "its" : "their"} own, so nothing has been bought alongside ${cart.length === 1 ? "it" : "them"} yet.`;
  }

  return {
    cart: cart.map((item) => ({ ...item, ordersContaining: containing(item.productId) })),
    ordersAnalyzed: orders.length,
    ordersContainingCartItems: ordersWithCartItems,
    suggestions,
    ...(message ? { message } : {}),
  };
}
