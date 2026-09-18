import { shopifyGraphQL } from "./shopify.js";
import { requireApproval } from "./approval.js";

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
    throw new Error(`No product found matching "${productName}".`);
  }

  throw new Error(
    `Multiple products found matching "${productName}". Please use the exact product name.`
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
    throw new Error(`No location found matching "${locationName}".`);
  }

  throw new Error(
    `Multiple locations found matching "${locationName}". Please use the exact location name.`
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

  if (!orderId?.trim()) {
    throw new Error("orderId is required.");
  }

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
      id: orderId,
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
      id: orderId,
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
      id: orderId,
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
    orderId,
    result,
  };
}