import "dotenv/config";

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { AGENT_OPTIONS } from "./agentConfig.js";
import { verifySessionToken } from "./verifySessionToken.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const port = Number(process.env.PORT || 3000);

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE_DOMAIN) {
  console.warn(
    "Warning: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET and SHOPIFY_STORE_DOMAIN must be set; " +
      "every API request will be rejected until they are.",
  );
}

// Shopify Admin refuses to iframe the app without this.
const FRAME_ANCESTORS_CSP = "frame-ancestors https://admin.shopify.com https://*.myshopify.com;";

// ---------------------------------------------------------------------------
// Agent session: one long-lived query() fed by a queue, same as the CLI model.
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(frame);
  }
}

function createSession() {
  const queue = [];
  let wake = null;
  let closed = false;

  async function* userMessages() {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = null;
        continue;
      }

      yield {
        type: "user",
        message: { role: "user", content: queue.shift() },
        parent_tool_use_id: null,
      };
    }
  }

  const conversation = query({ prompt: userMessages(), options: AGENT_OPTIONS });

  return {
    conversation,
    get closed() {
      return closed;
    },
    push(text) {
      queue.push(text);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
      conversation.close();
    },
  };
}

let session = null;

async function pumpSession(current) {
  const toolNames = new Map();

  try {
    for await (const message of current.conversation) {
      if (message.type === "assistant") {
        for (const block of message.message.content ?? []) {
          if (block.type === "text" && block.text) {
            broadcast("assistant_text", { text: block.text });
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            broadcast("tool_call", { id: block.id, name: block.name, input: block.input ?? {} });
          }
        }
      } else if (message.type === "user" && Array.isArray(message.message.content)) {
        // Tool results come back to the model as user-role messages.
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            broadcast("tool_result", {
              id: block.tool_use_id,
              name: toolNames.get(block.tool_use_id) ?? "tool",
              isError: Boolean(block.is_error),
              content: block.content ?? null,
            });
          }
        }
      } else if (message.type === "result") {
        broadcast("done", {
          ok: message.subtype === "success" && !message.is_error,
          error: message.subtype === "success" ? null : message.subtype,
        });
      }
    }
  } catch (error) {
    if (current.closed) {
      return;
    }
    console.error("Agent session failed:", error);
    broadcast("agent_error", { message: error.message || "Agent session failed." });
    broadcast("done", { ok: false, error: "session_failed" });
  } finally {
    // Start a fresh session on the next message if this one ended.
    if (session === current) {
      session = null;
    }
  }
}

function getSession() {
  if (!session) {
    session = createSession();
    void pumpSession(session);
  }
  return session;
}

function resetSession() {
  const current = session;
  session = null;
  current?.close();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authenticate(token) {
  try {
    return verifySessionToken(token, {
      clientId: SHOPIFY_CLIENT_ID,
      clientSecret: SHOPIFY_CLIENT_SECRET,
      shopDomain: SHOPIFY_STORE_DOMAIN,
    });
  } catch (error) {
    // Log why, plus the unverified routing claims, to debug rejected Admin tokens.
    // Never log the token itself or the secret.
    let claims = "";
    try {
      const { aud, dest, exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      claims = ` (aud=${aud}, dest=${dest}, exp=${exp}, now=${Math.floor(Date.now() / 1000)})`;
    } catch {
      // Token wasn't decodable; the reason already says so.
    }
    console.warn(`Rejected session token: ${error.message}${claims}`);
    return null;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function serveIndex(res) {
  const template = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
  const html = template.replace("%SHOPIFY_API_KEY%", escapeAttribute(SHOPIFY_CLIENT_ID));

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[".html"],
    "Content-Security-Policy": FRAME_ANCESTORS_CSP,
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function serveStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  const resolvedPath = path.resolve(publicDir, `.${decoded}`);
  if (!resolvedPath.startsWith(publicDir + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limitBytes) {
      throw Object.assign(new Error("Request body too large."), { status: 413 });
    }
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be JSON."), { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function handleEvents(req, res, url) {
  if (!authenticate(url.searchParams.get("token") || "")) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: status\ndata: ${JSON.stringify({ state: "connected" })}\n\n`);

  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

async function handleMessage(req, res) {
  if (!authenticate(bearerToken(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const payload = await readJsonBody(req);
  const text = String(payload.text ?? "").trim();
  if (!text) {
    sendJson(res, 400, { error: "Message text is required." });
    return;
  }

  getSession().push(text);
  sendJson(res, 202, { ok: true });
}

function handleReset(req, res) {
  if (!authenticate(bearerToken(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  resetSession();
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  // Route on the path only: Admin appends ?shop=&host=&embedded=1 to the document request.
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/events") {
      handleEvents(req, res, url);
    } else if (req.method === "POST" && pathname === "/api/message") {
      await handleMessage(req, res);
    } else if (req.method === "POST" && pathname === "/api/reset") {
      handleReset(req, res);
    } else if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
    } else if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Not found" });
    } else if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      await serveIndex(res);
    } else if (req.method === "GET") {
      await serveStatic(res, pathname);
    } else {
      sendJson(res, 405, { error: "Method not allowed" });
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
    } else {
      res.end();
    }
  }
});

server.listen(port, () => {
  console.log(`Shopify Ops UI is running at http://localhost:${server.address().port}`);
});
