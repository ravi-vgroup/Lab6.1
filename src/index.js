import "dotenv/config";

import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { AGENT_OPTIONS } from "./agentConfig.js";

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

function* historyUserMessages(history) {
  for (const entry of history) {
    if (!entry || entry.role !== "user") {
      continue;
    }

    yield {
      type: "user",
      message: {
        role: "user",
        content: entry.content,
      },
      parent_tool_use_id: null,
    };
  }
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
    if (rl.closed) {
      break;
    }

    const input = await new Promise((resolve) => {
      if (rl.closed) {
        resolve(null);
        return;
      }

      rl.question("You: ", resolve);
    });

    if (input === null) {
      break;
    }

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

  const history = [];

  try {
    while (true) {
      if (rl.closed) {
        break;
      }

      const input = await new Promise((resolve) => {
        if (rl.closed) {
          resolve(null);
          return;
        }

        rl.question("You: ", resolve);
      });

      if (input === null) {
        break;
      }

      const text = input.trim();

      if (!text) {
        continue;
      }

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        process.exit(0);
      }

      const prompt = text;
      let assistantReply = "";

      const conversation = query({
        prompt: historyUserMessages([...history, { role: "user", content: prompt }]),
        options: AGENT_OPTIONS,
      });

      for await (const message of conversation) {
        if (message.type === "assistant") {
          for (const block of message.message.content ?? []) {
            if (block.type === "text") {
              assistantReply += block.text;
              process.stdout.write(block.text);
            }
          }
        }
      }

      process.stdout.write("\n");
      history.push({ role: "user", content: text });
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