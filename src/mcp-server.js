import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  checkInventoryLevel,
  checkOrderRisk,
  getOrderDetails,
  updateOrderStatus,
} from "./tools.js";
import { requestOrderReview } from "./flow.js";
import { searchStorePolicies, startPolicyIndex } from "./rag/policyIndex.js";
import { getSalesSummary } from "./sales.js";
import { recommendUpsell } from "./upsell.js";

// Chunk and embed the store's policy pages once at startup.
startPolicyIndex().catch(() => {
  // Already logged; search_store_policies retries the build on first use.
});

const checkInventoryTool = tool(
  "check_inventory_level",
  "Check available inventory for a product at a specific Shopify location.\nRequires scopes: read_inventory, read_products, read_locations.",
  {
    productName: z.string().min(1),
    locationName: z.string().min(1),
  },
  async ({ productName, locationName }) => {
    try {
      const result = await checkInventoryLevel({
        productName,
        locationName,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Inventory check failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const updateOrderStatusTool = tool(
  "update_order_status",
  "Close, reopen, or cancel a Shopify order. Requires write_orders scope and an approval gate (admin/staff + confirmed).",
  {
    orderId: z.string().min(1),
    action: z.enum(["close", "reopen", "cancel"]),
    role: z.enum(["admin", "staff", "shopper"]),
    confirmed: z.boolean(),
  },
  async ({ orderId, action, role, confirmed }) => {
    try {
      const result = await updateOrderStatus({
        orderId,
        action,
        role,
        confirmed,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Order update failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const requestOrderReviewTool = tool(
  "request_order_review",
  "Trigger a Shopify Flow review workflow for an order id and reason. Requires admin/staff + confirmation.",
  {
    orderId: z.string().min(1),
    reason: z.string().min(1),
    role: z.enum(["admin", "staff", "shopper"]),
    confirmed: z.boolean(),
  },
  async ({ orderId, reason, role, confirmed }) => {
    try {
      const result = await requestOrderReview({
        orderId,
        reason,
        role,
        confirmed,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Flow review request failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const checkOrderRiskTool = tool(
  "check_order_risk",
  "Fetch an order risk assessment via the Shopify Admin API and decide whether it can auto-confirm.",
  {
    orderId: z.string().min(1),
  },
  async ({ orderId }) => {
    try {
      const result = await checkOrderRisk({ orderId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Order risk check failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const getOrderTool = tool(
  "get_order",
  "Fetch the Shopify Admin order details for a specific order ID, including customer, totals, and line items.",
  {
    orderId: z.string().min(1),
  },
  async ({ orderId }) => {
    try {
      const result = await getOrderDetails({ orderId });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Order lookup failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const searchStorePoliciesTool = tool(
  "search_store_policies",
  "Search the store's policy pages (privacy, refund, shipping, terms) and product descriptions. Returns the most relevant passages, or found=false when nothing matches closely enough.",
  {
    question: z.string().min(1),
  },
  async ({ question }) => {
    try {
      const result = await searchStorePolicies(question);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Policy search failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const getSalesSummaryTool = tool(
  "get_sales_summary",
  "Sales analytics for a date range: order count, total revenue, % change vs the equivalent prior period (null when the prior revenue was zero), and the top 3 products by order count. Pass startDate+endDate (YYYY-MM-DD, inclusive, UTC) or days (the last N days including today; default 30). Requires read_orders.",
  {
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.number().int().min(1).max(365).optional(),
  },
  async ({ startDate, endDate, days }) => {
    try {
      const result = await getSalesSummary({ startDate, endDate, days });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Sales summary failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const recommendUpsellTool = tool(
  "recommend_upsell",
  "Suggest up to 3 products to add to a cart, based on what customers who bought the cart's products also bought in recent orders. Takes the cart's Shopify product IDs (numeric or gid://shopify/Product/<id>). Returns an empty suggestions list when order history has no co-purchases. Requires read_orders.",
  {
    cartProductIds: z.array(z.string().min(1)).min(1).max(50),
  },
  async ({ cartProductIds }) => {
    try {
      const result = await recommendUpsell({ cartProductIds });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Upsell recommendation failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

export const opsServer = createSdkMcpServer({
  name: "shopify-ops",
  version: "1.0.0",
  tools: [
    checkInventoryTool,
    updateOrderStatusTool,
    requestOrderReviewTool,
    checkOrderRiskTool,
    getOrderTool,
    searchStorePoliciesTool,
    getSalesSummaryTool,
    recommendUpsellTool,
  ],
});