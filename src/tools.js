import { shopifyGraphQL } from "./shopify.js";
import { requireApproval } from "./approval.js";

export function normalizeOrderId(orderId) {
  const value = String(orderId ?? "").trim();

  if (!value) {
    throw new Error("orderId is required.");
  }

  if (value.startsWith("gid://shopify/Order/")) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    return `gid://shopify/Order/${value}`;
  }

  const match = value.match(/gid:\/\/shopify\/Order\/(\d+)/);
  if (match) {
    return `gid://shopify/Order/${match[1]}`;
  }

  return value;
}

/**
 * Pick a product from Shopify results.
 *
 * Exact title match wins.
 * If there is no exact match, a single substring match is allowed.
 * Zero or multiple matches are rejected.
 */
export function pickProductMatch(products, productName) {
  const exactMatches = products.filter(
    (product) =>
      product.title.toLowerCase() === productName.toLowerCase()
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    throw new Error(`Multiple exact products found for "${productName}".`);
  }

  const substringMatches = products.filter((product) =>
    product.title.toLowerCase().includes(productName.toLowerCase())
  );

  if (substringMatches.length === 1) {
    return substringMatches[0];
  }

  if (substringMatches.length === 0) {
    const available = products.map((product) => product.title).slice(0, 10);
    throw new Error(
      `No product found matching "${productName}". Available products: ${available.join(", ") || "none"}.`
    );
  }

  const available = substringMatches.map((product) => product.title).slice(0, 10);
  throw new Error(
    `Multiple products found matching "${productName}". Please use the exact product name. Similar matches: ${available.join(", ")}.`
  );
}

/**
 * Pick a location from Shopify results.
 *
 * Exact name match wins.
 * If there is no exact match, a single substring match is allowed.
 * Zero or multiple matches are rejected.
 */
export function pickLocationMatch(locations, locationName) {
  const exactMatches = locations.filter(
    (location) =>
      location.name.toLowerCase() === locationName.toLowerCase()
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    throw new Error(`Multiple exact locations found for "${locationName}".`);
  }

  const substringMatches = locations.filter((location) =>
    location.name.toLowerCase().includes(locationName.toLowerCase())
  );

  if (substringMatches.length === 1) {
    return substringMatches[0];
  }

  if (substringMatches.length === 0) {
    const available = locations.map((location) => location.name).slice(0, 10);
    throw new Error(
      `No location found matching "${locationName}". Available locations: ${available.join(", ") || "none"}.`
    );
  }

  const available = substringMatches.map((location) => location.name).slice(0, 10);
  throw new Error(
    `Multiple locations found matching "${locationName}". Please use the exact location name. Similar matches: ${available.join(", ")}.`
  );
}

/**
 * Resolve a product name to its Shopify product and variants.
 */
async function resolveProduct(productName) {
  const data = await shopifyGraphQL(
    `
      query SearchProducts($query: String!) {
        products(first: 50, query: $query) {
          nodes {
            id
            title
            variants(first: 100) {
              nodes {
                id
                title
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    `,
    {
      query: `title:${JSON.stringify(productName)}`,
    }
  );

  return pickProductMatch(data.products.nodes, productName);
}

/**
 * Resolve a location name to its Shopify location.
 */
async function resolveLocation(locationName) {
  const data = await shopifyGraphQL(`
    query GetLocations {
      locations(first: 250) {
        nodes {
          id
          name
        }
      }
    }
  `);

  return pickLocationMatch(data.locations.nodes, locationName);
}

/**
 * Read available inventory for a product at a location.
 */
export async function checkInventoryLevel({
  productName,
  locationName,
}) {
  if (!productName?.trim()) {
    throw new Error("productName is required.");
  }

  if (!locationName?.trim()) {
    throw new Error("locationName is required.");
  }

  const [product, location] = await Promise.all([
    resolveProduct(productName),
    resolveLocation(locationName),
  ]);

  const inventory = await Promise.all(
    product.variants.nodes.map(async (variant) => {
      const data = await shopifyGraphQL(
        `
          query GetInventory(
            $inventoryItemId: ID!
            $locationId: ID!
          ) {
            inventoryItem(id: $inventoryItemId) {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        `,
        {
          inventoryItemId: variant.inventoryItem.id,
          locationId: location.id,
        }
      );

      const available =
        data.inventoryItem?.inventoryLevel?.quantities?.find(
          (quantity) => quantity.name === "available"
        )?.quantity ?? 0;

      return {
        variantId: variant.id,
        variantTitle: variant.title,
        available,
      };
    })
  );

  return {
    productId: product.id,
    productName: product.title,
    locationId: location.id,
    locationName: location.name,
    variants: inventory,
  };
}
/**
 * Update an order status.
 *
 * Supported actions:
 * - close
 * - reopen
 * - cancel
 *
 * Approval is ALWAYS checked before making any Shopify write.
 */
export async function updateOrderStatus({
  orderId,
  action,
  role,
  confirmed,
}) {
  // IMPORTANT:
  // Approval happens BEFORE any Shopify API call.
  requireApproval({
    role,
    confirmed,
  });

  const normalizedOrderId = normalizeOrderId(orderId);

  const allowedActions = ["close", "reopen", "cancel"];

  if (!allowedActions.includes(action)) {
    throw new Error(
      `Invalid action "${action}". Use close, reopen, or cancel.`
    );
  }

  let mutation;
  let variables;

  if (action === "close") {
    mutation = `
      mutation CloseOrder($id: ID!) {
        orderClose(input: { id: $id }) {
          order {
            id
            name
            closed
            cancelledAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    variables = {
      id: normalizedOrderId,
    };
  }

  if (action === "reopen") {
    mutation = `
      mutation ReopenOrder($id: ID!) {
        orderOpen(input: { id: $id }) {
          order {
            id
            name
            closed
            cancelledAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    variables = {
      id: normalizedOrderId,
    };
  }

  if (action === "cancel") {
    mutation = `
      mutation CancelOrder($id: ID!) {
        orderCancel(
          orderId: $id
          reason: OTHER
          notifyCustomer: false
          restock: false
        ) {
          orderCancelUserErrors {
            field
            message
            code
          }
          job {
            id
          }
        }
      }
    `;

    variables = {
      id: normalizedOrderId,
    };
  }

  const data = await shopifyGraphQL(mutation, variables);

  const result =
    data.orderClose ||
    data.orderOpen ||
    data.orderCancel;

  const userErrors =
    result?.userErrors ||
    result?.orderCancelUserErrors ||
    [];

  if (userErrors.length > 0) {
    throw new Error(
      `Shopify order update failed: ${userErrors
        .map((error) => error.message)
        .join("; ")}`
    );
  }

  return {
    success: true,
    action,
    orderId: normalizedOrderId,
    result,
  };
}

export function shouldAutoConfirm(riskLevel) {
  const normalized = String(riskLevel ?? "").trim().toUpperCase();

  if (normalized === "LOW") {
    return { autoConfirm: true, reason: null };
  }

  if (normalized === "MEDIUM") {
    return { autoConfirm: false, reason: "flagged for manual review" };
  }

  if (normalized === "HIGH") {
    return { autoConfirm: false, reason: "held - high risk" };
  }

  throw new Error(`Unrecognized risk level: "${riskLevel}".`);
}

export async function checkOrderRisk({ orderId }) {
  if (!orderId?.trim()) {
    throw new Error("orderId is required.");
  }

  const normalizedOrderId = normalizeOrderId(orderId);
  const data = await shopifyGraphQL(
    `
      query GetOrderRisk($id: ID!) {
        order(id: $id) {
          id
          riskLevel
        }
      }
    `,
    {
      id: normalizedOrderId,
    }
  );

  const order = data?.order;
  const riskLevel = order?.riskLevel ?? order?.risk?.level ?? order?.risk?.riskLevel;

  if (riskLevel === undefined || riskLevel === null) {
    throw new Error(`No risk assessment returned for order ${normalizedOrderId}.`);
  }

  const decision = shouldAutoConfirm(riskLevel);

  return {
    orderId: normalizedOrderId,
    riskLevel,
    autoConfirm: decision.autoConfirm,
    reason: decision.reason,
  };
}

export async function getOrderDetails({ orderId }) {
  if (!orderId?.trim()) {
    throw new Error("orderId is required.");
  }

  const normalizedOrderId = normalizeOrderId(orderId);
  const data = await shopifyGraphQL(
    `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
          totalPrice
          subtotalPrice
          totalTax
          currencyCode
          customer {
            firstName
            lastName
            email
          }
          lineItems(first: 50) {
            nodes {
              title
              quantity
              variant {
                id
                title
              }
            }
          }
        }
      }
    `,
    {
      id: normalizedOrderId,
    }
  );

  if (!data?.order) {
    throw new Error(`No order found for ${normalizedOrderId}.`);
  }

  return {
    id: data.order.id,
    name: data.order.name,
    displayFinancialStatus: data.order.displayFinancialStatus,
    displayFulfillmentStatus: data.order.displayFulfillmentStatus,
    totalPrice: data.order.totalPrice,
    subtotalPrice: data.order.subtotalPrice,
    totalTax: data.order.totalTax,
    currencyCode: data.order.currencyCode,
    customer: data.order.customer,
    lineItems: (data.order.lineItems?.nodes ?? []).map((node) => ({
      title: node.title,
      quantity: node.quantity,
      variant: node.variant,
    })),
  };
}