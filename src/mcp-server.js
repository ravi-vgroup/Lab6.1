import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  checkInventoryLevel,
  updateOrderStatus,
} from "./tools.js";

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

export const opsServer = createSdkMcpServer({
  name: "shopify-ops",
  version: "1.0.0",
  tools: [
    checkInventoryTool,
    updateOrderStatusTool,
  ],
});