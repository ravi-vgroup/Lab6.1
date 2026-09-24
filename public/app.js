const messagesEl = document.getElementById('messages');
const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const connectionStatusText = document.getElementById('connectionStatusText');
const connectionStatusDot = document.getElementById('connectionStatusDot');

const WELCOME_TEXT =
  'Hello! Ask me about inventory or order status. For example: "Check the inventory status of The 3p Fulfilled Snowboard at the Snow City Warehouse location."';
const MAX_RECONNECT_DELAY_MS = 15000;
// Tool call/result cards are hidden; set to true to show them for debugging.
const SHOW_TOOL_CARDS = false;

let activeAssistantBubble = null;
let currentStreamSource = null;
let reconnectDelayMs = 1000;
let reconnectTimer = null;
let awaitingReply = false;

function setConnectionStatus(state, connected) {
  connectionStatusText.textContent = state;
  connectionStatusDot.classList.toggle('connected', connected);
}

// Outside the Admin iframe there is no App Bridge; the server only accepts that
// when started with `npm run ui:local`.
const isEmbedded = window.top !== window.self;
const UNAUTHORIZED_HINT = isEmbedded
  ? 'Unauthorized: the session token was rejected.'
  : 'Unauthorized. Open this app from Shopify Admin, or run `npm run ui:local` to use it in a local browser tab.';

// App Bridge session tokens are short-lived, so fetch a fresh one before every request.
// Resolves to null when running outside Admin.
async function getSessionToken() {
  if (!isEmbedded || !window.shopify || typeof window.shopify.idToken !== 'function') {
    return null;
  }
  return window.shopify.idToken();
}

async function authorizedFetch(url, options = {}) {
  const token = await getSessionToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 401) {
    throw new Error(UNAUTHORIZED_HINT);
  }
  return response;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

function ensureAssistantBubble() {
  if (!activeAssistantBubble) {
    activeAssistantBubble = addMessage('bot', '');
  }
  return activeAssistantBubble;
}

// MCP tool results arrive as [{ type: 'text', text: '...' }]; unwrap and pretty-print JSON text.
function formatToolContent(content) {
  const text = Array.isArray(content)
    ? content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('\n')
    : typeof content === 'string'
      ? content
      : JSON.stringify(content, null, 2);

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function addToolCard(variant, label, bodyText) {
  if (!SHOW_TOOL_CARDS) {
    // Still split the reply so text before and after the tool call doesn't run together.
    activeAssistantBubble = null;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = `tool-card ${variant}`;

  const header = document.createElement('div');
  header.className = 'tool-header';
  header.textContent = label;

  const body = document.createElement('div');
  body.className = 'tool-body';

  const pre = document.createElement('pre');
  pre.textContent = bodyText;

  body.appendChild(pre);
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  messagesEl.appendChild(wrapper);
  scrollToBottom();

  // Text after a tool card belongs in a new bubble below it.
  activeAssistantBubble = null;
}

function setLoading(isLoading) {
  awaitingReply = isLoading;
  sendBtn.disabled = isLoading;
  sendBtn.textContent = isLoading ? 'Thinking...' : 'Send';
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectStream, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

// EventSource can't send headers, so the token goes in the query string. We reconnect
// manually (instead of EventSource's auto-retry) so each attempt carries a fresh token.
async function connectStream() {
  if (currentStreamSource) {
    currentStreamSource.close();
    currentStreamSource = null;
  }

  setConnectionStatus('Connecting...', false);

  let token;
  try {
    token = await getSessionToken();
  } catch (error) {
    setConnectionStatus(`Session token error: ${error.message}`, false);
    scheduleReconnect();
    return;
  }

  const source = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events');
  currentStreamSource = source;

  source.addEventListener('status', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.state === 'connected') {
      reconnectDelayMs = 1000;
      setConnectionStatus(isEmbedded ? 'Connected' : 'Connected (local mode)', true);
    }
  });

  source.addEventListener('assistant_text', (event) => {
    const payload = JSON.parse(event.data);
    const bubble = ensureAssistantBubble();
    bubble.textContent += payload.text;
    scrollToBottom();
  });

  source.addEventListener('tool_call', (event) => {
    const payload = JSON.parse(event.data);
    addToolCard('call', `Tool call · ${payload.name}`, JSON.stringify(payload.input, null, 2));
  });

  source.addEventListener('tool_result', (event) => {
    const payload = JSON.parse(event.data);
    const variant = payload.isError ? 'result error' : 'result';
    const label = `${payload.isError ? 'Tool error' : 'Tool result'} · ${payload.name}`;
    addToolCard(variant, label, formatToolContent(payload.content));
  });

  // Not named "error": that would collide with EventSource's own connection-error event.
  source.addEventListener('agent_error', (event) => {
    addMessage('bot', `Error: ${JSON.parse(event.data).message}`);
  });

  source.addEventListener('done', () => {
    activeAssistantBubble = null;
    setLoading(false);
  });

  source.onerror = () => {
    if (source !== currentStreamSource) {
      return;
    }
    source.close();
    currentStreamSource = null;
    setConnectionStatus(
      isEmbedded ? 'Disconnected. Reconnecting...' : 'Not connected. Run `npm run ui:local` for local use. Retrying...',
      false,
    );
    scheduleReconnect();
  };
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || awaitingReply) {
    return;
  }

  addMessage('user', text);
  input.value = '';
  activeAssistantBubble = null;
  setLoading(true);

  try {
    const response = await authorizedFetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
  } catch (error) {
    addMessage('bot', `Error: ${error.message}`);
    setLoading(false);
  } finally {
    input.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

newChatBtn.addEventListener('click', async () => {
  try {
    const response = await authorizedFetch('/api/reset', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Reset failed (${response.status}).`);
    }
  } catch (error) {
    addMessage('bot', `Error: ${error.message}`);
    return;
  }

  messagesEl.innerHTML = '';
  addMessage('bot', WELCOME_TEXT);
  activeAssistantBubble = null;
  setLoading(false);
  input.focus();
});

input.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    sendMessage();
  }
});

connectStream();
input.focus();
