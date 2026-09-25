const messagesEl = document.getElementById('messages');
const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const connectionStatusText = document.getElementById('connectionStatusText');
const connectionStatusDot = document.getElementById('connectionStatusDot');

const WELCOME_TEXT =
  'Hello! Ask me about inventory, orders, store policies or sales. For example: "How were my sales in the last 7 days?"';
const MAX_RECONNECT_DELAY_MS = 15000;
// Tool call/result cards are hidden; set to true to show them for debugging.
const SHOW_TOOL_CARDS = false;

let activeAssistantBubble = null;
let currentStreamSource = null;
let reconnectDelayMs = 1000;
let reconnectTimer = null;
let awaitingReply = false;
// Range of the last get_sales_summary call in the current reply, if any.
let pendingSalesRange = null;

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

// Agent replies use light markdown. Escape everything first, then allow only
// **bold** and `code`, so model output can never inject HTML.
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
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
    // Keep the raw text and re-render, since a **bold** span can arrive split across chunks.
    bubble.dataset.raw = (bubble.dataset.raw ?? '') + payload.text;
    bubble.innerHTML = renderMarkdown(bubble.dataset.raw);
    scrollToBottom();
  });

  source.addEventListener('tool_call', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.name.endsWith('get_sales_summary')) {
      pendingSalesRange = normalizeSalesRange(payload.input);
    }
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
    if (pendingSalesRange) {
      addSalesActions(pendingSalesRange);
      pendingSalesRange = null;
    }
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

// ---------------------------------------------------------------------------
// Sales analytics view + Excel download
// ---------------------------------------------------------------------------

const chatView = document.getElementById('chatView');
const salesView = document.getElementById('salesView');
const viewTabs = document.querySelectorAll('.view-tab');
const presetButtons = document.querySelectorAll('.preset');
const customRangeForm = document.getElementById('customRange');
const rangeStartInput = document.getElementById('rangeStart');
const rangeEndInput = document.getElementById('rangeEnd');
const downloadExcelBtn = document.getElementById('downloadExcelBtn');
const salesContent = document.getElementById('salesContent');
const salesError = document.getElementById('salesError');
const salesPeriodLabel = document.getElementById('salesPeriodLabel');

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12" /></svg>';
const CHART_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17h14M5 14V9m4 5V5m4 9v-3m4 3V7" /></svg>';

const salesState = { range: { days: 7 }, requestId: 0, loadedKey: null };

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// The tool's own default is 30 days when the agent passes no range.
function normalizeSalesRange(input = {}) {
  if (input.startDate && input.endDate) return { startDate: input.startDate, endDate: input.endDate };
  return { days: Number(input.days) || 30 };
}

function rangeToParams(range) {
  return new URLSearchParams(
    range.days ? { days: String(range.days) } : { startDate: range.startDate, endDate: range.endDate },
  );
}

function formatMoney(value, currency) {
  if (value === null || value === undefined) return '—';
  if (typeof currency === 'string') {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      // Unknown currency code; fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatPeriod(period) {
  return period.startDate === period.endDate
    ? formatDate(period.startDate)
    : `${formatDate(period.startDate)} – ${formatDate(period.endDate)}`;
}

function showView(view) {
  const isSales = view === 'sales';
  chatView.hidden = isSales;
  salesView.hidden = !isSales;
  newChatBtn.hidden = isSales;
  viewTabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  const key = rangeToParams(salesState.range).toString();
  if (isSales && salesState.loadedKey !== key) {
    loadSales();
  }
  if (!isSales) input.focus();
}

function syncPresetButtons() {
  const { range } = salesState;
  const month = range.startDate && range.startDate === `${todayUtc().slice(0, 8)}01` && range.endDate === todayUtc();
  presetButtons.forEach((button) => {
    const active = button.dataset.days
      ? Number(button.dataset.days) === range.days
      : button.dataset.preset === 'month'
        ? Boolean(month)
        : !range.days && !month;
    button.classList.toggle('active', active);
  });
}

function setSalesRange(range) {
  salesState.range = range;
  syncPresetButtons();
  if (range.startDate) {
    rangeStartInput.value = range.startDate;
    rangeEndInput.value = range.endDate;
  }
}

function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.querySelector('span')?.textContent ?? '';
    button.disabled = true;
    const label = button.querySelector('span');
    if (label) label.textContent = busyLabel;
  } else {
    button.disabled = false;
    const label = button.querySelector('span');
    if (label && button.dataset.label) label.textContent = button.dataset.label;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function barRow(className, label, value, displayValue, max) {
  const row = el('div', `compare-row ${className}`);
  row.append(el('span', '', label));
  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  fill.style.width = `${max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0}%`;
  track.append(fill);
  row.append(track, el('span', 'compare-value', displayValue));
  return row;
}

function renderSales(data) {
  const currency = data.currency;
  salesPeriodLabel.textContent = `${formatPeriod(data.currentPeriod)}  ·  compared with ${formatPeriod(data.previousPeriod)}  ·  UTC`;

  document.getElementById('kpiRevenue').textContent = formatMoney(data.totalRevenue, currency);
  const delta = document.getElementById('kpiRevenueDelta');
  if (data.revenueChangePercent === null) {
    delta.className = 'delta neutral';
    delta.textContent = 'No revenue in previous period';
  } else {
    const up = data.revenueChangePercent >= 0;
    delta.className = `delta ${up ? 'up' : 'down'}`;
    delta.textContent = `${up ? '▲' : '▼'} ${Math.abs(data.revenueChangePercent).toFixed(2)}% vs previous`;
  }

  document.getElementById('kpiOrders').textContent = data.orderCount.toLocaleString();
  document.getElementById('kpiOrdersSub').textContent = `${data.previousOrderCount.toLocaleString()} in previous period`;
  document.getElementById('kpiAov').textContent = formatMoney(data.averageOrderValue, currency);
  document.getElementById('kpiAovSub').textContent =
    data.previousAverageOrderValue === null ? 'No orders in previous period' : `${formatMoney(data.previousAverageOrderValue, currency)} previously`;
  document.getElementById('kpiPrevRevenue').textContent = formatMoney(data.previousRevenue, currency);
  document.getElementById('kpiPrevSub').textContent = formatPeriod(data.previousPeriod);

  const list = document.getElementById('productList');
  list.replaceChildren();
  const products = data.products.slice(0, 5);
  const maxOrders = Math.max(...products.map((p) => p.orderCount), 0);
  for (const [i, product] of products.entries()) {
    const row = el('li', 'product-row');
    const name = el('span', 'product-name', product.title);
    name.title = product.title;
    const count = el(
      'span',
      'product-count',
      `${product.orderCount} ${product.orderCount === 1 ? 'order' : 'orders'} · ${product.units} ${product.units === 1 ? 'unit' : 'units'}`,
    );
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${maxOrders ? (product.orderCount / maxOrders) * 100 : 0}%`;
    track.append(fill);
    row.append(el('span', 'product-rank', String(i + 1)), name, count, track);
    list.append(row);
  }
  document.getElementById('productsEmpty').hidden = products.length > 0;

  const comparison = document.getElementById('comparison');
  comparison.replaceChildren();
  const metrics = [
    ['Revenue', data.totalRevenue, data.previousRevenue, (v) => formatMoney(v, currency)],
    ['Orders', data.orderCount, data.previousOrderCount, (v) => v.toLocaleString()],
  ];
  for (const [label, current, previous, format] of metrics) {
    const block = el('div', 'compare-metric');
    const max = Math.max(current, previous);
    block.append(
      el('h3', '', label),
      barRow('current', 'Current', current, format(current), max),
      barRow('previous', 'Previous', previous, format(previous), max),
    );
    comparison.append(block);
  }

  if (data.warning) {
    salesError.textContent = data.warning;
    salesError.hidden = false;
  }
}

async function loadSales() {
  const requestId = ++salesState.requestId;
  const params = rangeToParams(salesState.range);
  salesContent.classList.add('loading');
  salesError.hidden = true;

  try {
    const response = await authorizedFetch(`/api/sales/summary?${params}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Could not load sales (${response.status}).`);
    }
    if (requestId !== salesState.requestId) return;
    renderSales(data);
    salesState.loadedKey = params.toString();
  } catch (error) {
    if (requestId !== salesState.requestId) return;
    salesError.textContent = error.message;
    salesError.hidden = false;
  } finally {
    if (requestId === salesState.requestId) salesContent.classList.remove('loading');
  }
}

async function downloadSalesExcel(range, button) {
  const params = rangeToParams(range);
  // Inside the Admin iframe a blob download can be blocked by the iframe sandbox, so the
  // file opens in a new tab instead. Open it synchronously (before awaiting the token)
  // so the browser still treats it as a user-initiated popup.
  const popup = isEmbedded ? window.open('', '_blank') : null;
  setBusy(button, true, 'Preparing…');

  try {
    if (isEmbedded) {
      const token = await getSessionToken();
      if (token) params.set('token', token);
      const url = `${window.location.origin}/api/sales/export?${params}`;
      if (popup) {
        popup.opener = null;
        popup.location.href = url;
      } else {
        window.location.href = url;
      }
      return;
    }

    const response = await authorizedFetch(`/api/sales/export?${params}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Export failed (${response.status}).`);
    }
    const blob = await response.blob();
    const filename =
      /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'sales-report.xlsx';
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    popup?.close();
    if (salesView.hidden) {
      addMessage('bot', `Error: ${error.message}`);
    } else {
      salesError.textContent = error.message;
      salesError.hidden = false;
    }
  } finally {
    setBusy(button, false);
  }
}

// Buttons under a chat answer that used get_sales_summary.
function addSalesActions(range) {
  const row = el('div', 'message-actions');

  const excel = el('button', 'inline-action excel');
  excel.type = 'button';
  excel.innerHTML = `${DOWNLOAD_ICON}<span>Download Excel</span>`;
  excel.addEventListener('click', () => downloadSalesExcel(range, excel));

  const open = el('button', 'inline-action');
  open.type = 'button';
  open.innerHTML = `${CHART_ICON}<span>Open in Sales analytics</span>`;
  open.addEventListener('click', () => {
    setSalesRange(range);
    showView('sales');
  });

  row.append(excel, open);
  messagesEl.append(row);
  scrollToBottom();
}

viewTabs.forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

presetButtons.forEach((button) =>
  button.addEventListener('click', () => {
    if (button.dataset.preset === 'custom') {
      presetButtons.forEach((other) => other.classList.toggle('active', other === button));
      customRangeForm.hidden = false;
      if (!rangeStartInput.value) {
        rangeEndInput.value = todayUtc();
        rangeStartInput.value = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
      }
      rangeStartInput.focus();
      return;
    }

    customRangeForm.hidden = true;
    setSalesRange(
      button.dataset.preset === 'month'
        ? { startDate: `${todayUtc().slice(0, 8)}01`, endDate: todayUtc() }
        : { days: Number(button.dataset.days) },
    );
    loadSales();
  }),
);

customRangeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (rangeEndInput.value < rangeStartInput.value) {
    salesError.textContent = 'The "To" date must be on or after the "From" date.';
    salesError.hidden = false;
    return;
  }
  setSalesRange({ startDate: rangeStartInput.value, endDate: rangeEndInput.value });
  loadSales();
});

downloadExcelBtn.addEventListener('click', () => downloadSalesExcel(salesState.range, downloadExcelBtn));

rangeEndInput.max = todayUtc();
rangeStartInput.max = todayUtc();

connectStream();
// `#sales` deep-links straight to the analytics view.
if (window.location.hash === '#sales') {
  showView('sales');
} else {
  input.focus();
}
