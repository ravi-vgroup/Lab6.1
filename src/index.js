import "dotenv/config";

import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { opsServer } from "./mcp-server.js";
const AGENT_OPTIONS = {
  model: "sonnet",

  // Do not load external/project/user MCP settings.
  settingSources: [],

  // Disable built-in Claude tools.
  tools: [],

  // Only our two Shopify operations tools are allowed.
  allowedTools: [
    "mcp__shopify-ops__check_inventory_level",
    "mcp__shopify-ops__update_order_status",
  ],

  systemPrompt: `
You are a Shopify operations agent.

You have exactly two tools available:

1. check_inventory_level
   - Read-only inventory lookup.
   - Requires a product name and location name.
   - Never guess when a product or location is ambiguous.

2. update_order_status
   - Can close, reopen, or cancel an order.
   - This is a real Shopify write.
   - The tool itself enforces the approval gate.
   - Never claim a write succeeded unless the tool reports success.

Be concise and factual in your responses.
`,

  mcpServers: {
    "shopify-ops": opsServer,
  },
};

// const AGENT_OPTIONS = {
//   model: "sonnet",

//   allowedTools: [
//     "mcp__shopify-ops__check_inventory_level",
//     "mcp__shopify-ops__update_order_status",
//   ],

//   systemPrompt: `
// You are a Shopify operations agent.

// You have exactly two tools available:

// 1. check_inventory_level
//    - Read-only inventory lookup.
//    - Requires a product name and location name.
//    - Never guess when a product or location is ambiguous.

// 2. update_order_status
//    - Can close, reopen, or cancel an order.
//    - This is a real Shopify write.
//    - The tool itself enforces the approval gate.
//    - Never claim a write succeeded unless the tool reports success.

// Be concise and factual in your responses.
// `,

//   mcpServers: {
//     "shopify-ops": opsServer,
//   },
// };

function printAssistantMessage(message) {
  if (message.type !== "assistant") {
    return;
  }

  for (const block of message.message.content ?? []) {
    if (block.type === "text") {
      process.stdout.write(block.text);
    }
  }

  process.stdout.write("\n");
}

async function runOneShot(prompt) {
  const conversation = query({
    prompt,
    options: AGENT_OPTIONS,
  });

  for await (const message of conversation) {
    printAssistantMessage(message);
  }
}

async function* userMessageStream(rl) {
  while (true) {
    const input = await new Promise((resolve) => {
      rl.question("You: ", resolve);
    });

    const text = input.trim();

    if (!text) {
      continue;
    }

    if (
      text.toLowerCase() === "exit" ||
      text.toLowerCase() === "quit"
    ) {
      process.exit(0);
    }

    yield {
      type: "user",
      message: {
        role: "user",
        content: text,
      },
    };
  }
}

async function runRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Shopify Ops Agent");
  console.log('Type "exit" or "quit" to leave.');
  console.log("");

  const conversation = query({
    prompt: userMessageStream(rl),
    options: AGENT_OPTIONS,
  });

  try {
    for await (const message of conversation) {
      printAssistantMessage(message);
    }
  } finally {
    rl.close();
  }
}

const prompt = process.argv.slice(2).join(" ").trim();

if (prompt) {
  await runOneShot(prompt);
} else {
  await runRepl();
}