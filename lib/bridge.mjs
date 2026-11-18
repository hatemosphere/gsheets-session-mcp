import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export const BRIDGE_PORT = 17834;
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;

// Loopback-only transport for the Chrome extension. Browser pages cannot
// impersonate an extension because their WebSocket Origin is rejected.
export class BrowserBridge {
  #http;
  #wss;
  #socket;
  #ping;
  #pending = new Map();
  #waiters = new Set();
  onEvent = null;

  async listen(port = BRIDGE_PORT) {
    this.#http = createServer((_, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket required\n');
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: 25 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.#http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || !req.headers.origin?.startsWith('chrome-extension://')) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
    });
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(port, '127.0.0.1', () => {
        this.#http.off('error', reject);
        resolve();
      });
    });
  }

  async request(action, params) {
    await this.#waitForSocket();
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Browser bridge disconnected. Retry the request.');
    }

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Browser request timed out. Keep the Sheets tab open and try again.'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { socket, timeout, resolve, reject });
      socket.send(JSON.stringify({ type: 'request', id, action, params }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        reject(error);
      });
    });
  }

  #accept(socket) {
    if (this.#socket && this.#socket !== socket) {
      this.#rejectAll(new Error('Browser extension reconnected; retry the request.'));
      this.#socket.close(1012, 'Extension reconnected');
      clearInterval(this.#ping);
    }
    this.#socket = socket;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.#waiters.clear();

    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'pong') return;
      if (msg.type === 'event') {
        this.onEvent?.(msg.event);
        return;
      }
      if (msg.type !== 'response' || typeof msg.id !== 'string') return;
      const pending = this.#pending.get(msg.id);
      if (!pending || pending.socket !== socket) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) pending.reject(new Error(String(msg.error)));
      else pending.resolve(msg.result);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      clearInterval(this.#ping);
      this.#rejectAll(new Error('Browser extension disconnected.'));
    });

    // WebSocket traffic resets the MV3 service worker's idle timer on Chrome.
    this.#ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  }

  #waitForSocket() {
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timeout = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(
          'Browser bridge is not connected. Load the extension/ directory in Chrome and keep the spreadsheet open.',
        ));
      }, CONNECT_TIMEOUT_MS);
      this.#waiters.add(waiter);
    });
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #rejectWaiters(error) {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  close() {
    clearInterval(this.#ping);
    this.#rejectAll(new Error('MCP server is shutting down.'));
    this.#rejectWaiters(new Error('MCP server is shutting down.'));
    this.#socket?.terminate();
    this.#socket = null;
    this.#wss?.close();
    this.#http?.close();
  }
}
