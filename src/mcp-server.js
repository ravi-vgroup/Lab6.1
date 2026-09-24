import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  checkInventoryLevel,
  checkOrderRisk,
  getOrderDetails,
  updateOrderStatus,
} from "./tools.js";
import { requestOrderReview } from "./flow.js";

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

export const opsServer = createSdkMcpServer({
  name: "shopify-ops",
  version: "1.0.0",
  tools: [
    checkInventoryTool,
    updateOrderStatusTool,
    requestOrderReviewTool,
    checkOrderRiskTool,
    getOrderTool,
  ],
});