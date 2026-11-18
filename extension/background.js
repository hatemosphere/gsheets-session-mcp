const BRIDGE_URL = 'ws://127.0.0.1:17834/bridge';
let socket;
let reconnectTimer;
let retryDelay = 1_000;

const streamBatches = new Map();

function sendEvent(event) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'event', event }));
  }
}

function requestBodyObject(requestBody) {
  if (requestBody?.formData) return requestBody.formData;
  if (requestBody?.raw?.length) {
    const text = requestBody.raw.map((part) => {
      try { return new TextDecoder().decode(new Uint8Array(part.bytes)); } catch { return ''; }
    }).join('');
    const form = new URLSearchParams(text);
    const result = {};
    for (const [key, value] of form) (result[key] ||= []).push(value);
    return result;
  }
  return null;
}

function maybeCaptureSave(tabId, url, requestBody) {
  if (tabId < 0 || url.includes('mcpReplay=1')) return;
  let path;
  try { path = new URL(url).pathname; } catch { return; }
  if (!/\/spreadsheets\/(?:u\/\d+\/)?d\/[^/]+\/save$/.test(path)) return;
  const body = requestBodyObject(requestBody);
  if (!body) return;
  sendEvent({ kind: 'save_capture', tabId, at: Date.now(), url, body });
}

function queueStreamBatch(tabId, url, requestBody) {
  if (tabId < 0 || url.includes('mcpReplay=1')) return;
  let path;
  try { path = new URL(url).pathname; } catch { return; }
  const match = /\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)\/streamrows$/.exec(path);
  if (!match) return;
  const body = requestBodyObject(requestBody);
  if (!body) return;
  const snapshotAt = Number(body.snapshotAt?.[0]);
  if (!Number.isInteger(snapshotAt)) return;

  const spreadsheetId = match[1];
  const key = `${tabId}:${spreadsheetId}:${snapshotAt}`;
  let batch = streamBatches.get(key);
  if (!batch) {
    batch = { spreadsheetId, tabId, snapshotAt, requests: [], timer: null };
    streamBatches.set(key, batch);
  }
  batch.requests.push({ url, body });
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    streamBatches.delete(key);
    sendEvent({
      kind: 'streamrows_batch',
      spreadsheetId,
      tabId,
      snapshotAt,
      at: Date.now(),
      requests: batch.requests,
    });
  }, 600);
}

async function hasSheetTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/d/*' });
    return tabs.length > 0;
  } catch { return false; }
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  // The MCP is the WebSocket server; it only runs when a sheet is in use. With no
  // Sheets tab open there is nothing to serve, so skip the connect and avoid a
  // (browser-logged) net::ERR_CONNECTION_REFUSED while the MCP is not running.
  if (!(await hasSheetTab())) return;
  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;

  ws.onopen = () => {
    retryDelay = 1_000;
    sendEvent({ kind: 'bridge_connected', at: Date.now() });
  };
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type !== 'request') return;

    let response;
    try {
      const result = msg.action === 'list_sheets'
        ? await listSheets()
        : await runInSheet(msg.action, msg.params);
      response = { type: 'response', id: msg.id, result };
    } catch (error) {
      response = { type: 'response', id: msg.id, error: String(error.message ?? error) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  };
  ws.onerror = () => { ws.close(); };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  };
}

async function listSheets() {
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/d/*' });
  const sheets = [];
  for (const tab of tabs) {
    const idMatch = /\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)/.exec(tab.url ?? '');
    if (!idMatch) continue;
    const gidMatch = /[#?&]gid=(\d+)/.exec(tab.url ?? '');
    sheets.push({
      spreadsheetId: idMatch[1],
      gid: gidMatch ? gidMatch[1] : null,
      title: tab.title ?? null,
      url: tab.url ?? null,
      active: tab.active === true,
      tabId: tab.id ?? null,
      windowId: tab.windowId ?? null,
    });
  }
  return sheets;
}

async function runInSheet(action, params) {
  const spreadsheetId = params.spreadsheetId;
  const tabs = await chrome.tabs.query({
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/*`,
  });
  const tab = tabs.find((candidate) => candidate.id !== undefined);
  if (!tab) {
    throw new Error(`Open https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit in Chrome and try again.`);
  }

  const message = { type: 'gsheets-session-request', action, params };
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    // Tabs opened before the extension was installed do not need a manual reload.
    if (!/Receiving end does not exist|Could not establish connection/.test(String(error.message))) throw error;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    reply = await chrome.tabs.sendMessage(tab.id, message);
  }
  if (reply?.error) throw new Error(reply.error);
  if (!reply || !('result' in reply)) throw new Error('Sheets tab returned no response. Reload the tab and try again.');
  return reply.result;
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') connect();
});
chrome.webRequest.onBeforeRequest.addListener((details) => {
  queueStreamBatch(details.tabId, details.url, details.requestBody);
  maybeCaptureSave(details.tabId, details.url, details.requestBody);
}, { urls: ['https://docs.google.com/spreadsheets/*'] }, ['requestBody']);
chrome.alarms.create('gsheets-session-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();
