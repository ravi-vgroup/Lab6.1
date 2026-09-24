import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { opsServer } from "./mcp-server.js";
import { triggerFlow } from "./flow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [],
      queue: [],
      clients: new Set(),
      processing: false,
    });
  }

  return sessions.get(sessionId);
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

async function* userMessages(session) {
  const history = session.history ?? [];
  for (const message of historyUserMessages(history)) {
    yield message;
  }

  while (session.queue.length > 0) {
    const message = session.queue.shift();
    yield {
      type: "user",
      message: {
        role: "user",
        content: message,
      },
    };
  }
}

function emitSessionEvent(sessionId, eventName, payload) {
  const session = getSession(sessionId);
  const event = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of [...session.clients]) {
    client.write(event);
  }
}

const AGENT_OPTIONS = {
  model: "sonnet",
  settingSources: [],
  tools: [],
  allowedTools: [
    "mcp__shopify-ops__check_inventory_level",
    "mcp__shopify-ops__update_order_status",
    "mcp__shopify-ops__request_order_review",
    "mcp__shopify-ops__check_order_risk",
    "mcp__shopify-ops__get_order",
  ],
  systemPrompt: `
You are a Shopify operations agent.

You have exactly five tools available:

1. check_inventory_level
   - Read-only inventory lookup.
   - Requires a product name and location name.
   - Never guess when a product or location is ambiguous.

2. get_order
   - Read an existing order by Shopify order ID.
   - Use this for order details, totals, line items, and customer data.
   - Works with numeric order IDs or Shopify global IDs and normalizes them automatically.

3. update_order_status
   - Can close, reopen, or cancel an order.
   - This is a real Shopify write.
   - The tool itself enforces the approval gate.
   - Never claim a write succeeded unless the tool reports success.

4. request_order_review
   - Triggers a Shopify Flow workflow for governed review.
   - Use this when a write should be routed through a configured workflow instead of direct Admin API mutation.
   - Requires admin/staff and explicit confirmation.

5. check_order_risk
   - Reads an order's risk assessment from the Shopify Admin API.
   - Uses the risk level to decide whether the order can auto-confirm.
   - Declines for MEDIUM/HIGH and throws on unrecognized values instead of defaulting to auto-confirm.

Be concise and factual in your responses.
`,
  mcpServers: {
    "shopify-ops": opsServer,
  },
};

async function runAgent(sessionId, prompt) {
  const session = getSession(sessionId);
  const pendingHistory = [...session.history, { role: "user", content: prompt }];
  const conversation = query({
    prompt: historyUserMessages(pendingHistory),
    options: AGENT_OPTIONS,
  });

  let reply = "";
  let hasText = false;

  for await (const message of conversation) {
    if (message.type !== "assistant") {
      continue;
    }

    for (const block of message.message.content ?? []) {
      if (block.type === "text") {
        const value = String(block.text ?? "");
        if (!value) {
          continue;
        }

        hasText = true;
        reply += value;
        emitSessionEvent(sessionId, "assistant_text", { text: value });
      }

      if (block.type === "tool_use") {
        emitSessionEvent(sessionId, "assistant_tool", {
          kind: "tool_call",
          name: block.name,
          input: block.input ?? {},
        });
      }

      if (block.type === "tool_result") {
        emitSessionEvent(sessionId, "assistant_tool", {
          kind: "tool_result",
          name: block.tool_use_id ?? "tool-result",
          output: block.content ?? null,
        });
      }
    }
  }

  const finalReply = (reply || "").trim() || "No response received from the agent.";

  session.history.push({ role: "user", content: prompt });

  emitSessionEvent(sessionId, "assistant_done", { text: finalReply });
  return finalReply;
}

async function processSessionQueue(sessionId) {
  const session = getSession(sessionId);

  if (session.processing) {
    return;
  }

  session.processing = true;

  try {
    while (session.queue.length > 0) {
      const prompt = session.queue.shift();
      await runAgent(sessionId, prompt);
    }
  } finally {
    session.processing = false;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStaticFile(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, decodeURIComponent(safePath));
  const resolvedPath = path.resolve(filePath);

  if (!resolvedPath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/events") {
    const sessionId = String(url.searchParams.get("sessionId") || "demo-session");
    const session = getSession(sessionId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    session.clients.add(res);
    res.write(`event: status\ndata: ${JSON.stringify({ state: "connected" })}\n\n`);

    req.on("close", () => {
      session.clients.delete(res);
    });

    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "shopify-ops-demo" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body || "{}");
      const sessionId = String(payload.sessionId || "demo-session");
      const message = String(payload.message || "").trim();

      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Message is required." }));
        return;
      }

      const session = getSession(sessionId);
      session.queue.push(message);
      void processSessionQueue(sessionId);

      res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, sessionId }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message || "Unknown server error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/flow-trigger") {
    try {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await triggerFlow({
        handle: payload.handle || "order-review-requested",
        payload: {
          order_id: String(payload.orderId || ""),
          reason: String(payload.reason || "manual-review"),
        },
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error.message || "Unknown server error" }));
    }
    return;
  }

  await serveStaticFile(req, res, url.pathname);
});

server.listen(port, () => {
  const actualPort = server.address().port;
  console.log(`Shopify Ops UI is running at http://localhost:${actualPort}`);
});

