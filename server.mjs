#!/usr/bin/env node
// stdio MCP for Google Sheets via the browser-session /save protocol + gviz reads.
// The Chrome extension executes requests in an open Sheets tab, so Google
// cookies and session tokens never enter this process. No OAuth or API key.
// Config: ./secrets.local.json { spreadsheetId, gid } (optional starting rev).
// Writes: strings & numbers only (formulas use a compiled bytecode we don't generate).

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load } from 'cheerio';
import { ActivityLog } from './lib/activity.mjs';
import { buildBundles, parseA1 } from './lib/encode.mjs';
import { decodeStreamRows } from './lib/streamrows.mjs';
import { BRIDGE_PORT, BrowserBridge } from './lib/bridge.mjs';

const CFG = resolve(dirname(fileURLToPath(import.meta.url)), 'secrets.local.json');
const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
for (const key of ['spreadsheetId', 'gid']) {
  if (typeof cfg[key] !== 'string' && typeof cfg[key] !== 'number') {
    throw new Error(`secrets.local.json missing "${key}"`);
  }
}

const activity = new ActivityLog(cfg.activity);
let lastActivityRevision = null;
let lastChannelSnapshotAt = null;
let activityQueue = Promise.resolve();

const bridge = new BrowserBridge();
bridge.onEvent = (event) => {
  handleActivityEvent(event).catch(() => {});
};
await bridge.listen();
console.error(`[gsheets-session] browser bridge listening on ws://127.0.0.1:${BRIDGE_PORT}/bridge`);

// The save session ID must be one Google has already accepted. Keep the
// captured value; only generate one for a fresh config. Cookies, tokens and
// the Google account remain entirely inside the browser.
const sid = typeof cfg.sid === 'string' && /^[a-f0-9]{16}$/i.test(cfg.sid)
  ? cfg.sid
  : randomBytes(8).toString('hex');
let reqId = Number.isInteger(cfg.reqId) ? cfg.reqId : 0;
let rev = Number.isFinite(cfg.rev) ? cfg.rev : 0;

function saveSession() {
  try { writeFileSync(CFG, JSON.stringify({ ...cfg, sid, reqId, rev }, null, 2)); } catch {}
}

// --- read via gviz (returns 2D array of strings) ---
function parseCsv(text) {
  const rows = [[]];
  let field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { rows.at(-1).push(field); field = ''; }
    else if (ch === '\n') { rows.at(-1).push(field); field = ''; rows.push([]); }
    else if (ch !== '\r') field += ch;
  }
  rows.at(-1).push(field);
  if (rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  return rows;
}

async function browserRequest(action, params) {
  const result = await bridge.request(action, {
    spreadsheetId: cfg.spreadsheetId,
    gid: cfg.gid,
    ...params,
  });
  if (!result || typeof result !== 'object') {
    throw new Error('Browser extension returned an invalid response.');
  }
  return result;
}

async function browserHttp(action, params) {
  const result = await browserRequest(action, params);
  if (!Number.isInteger(result.status) || typeof result.text !== 'string') {
    throw new Error('Browser extension returned an invalid HTTP response.');
  }
  return result;
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function parseRangeBounds(range) {
  const [first, last = first] = String(range).split(':');
  const a = parseA1(first);
  const b = parseA1(last);
  return {
    minRow: Math.min(a.row, b.row),
    maxRow: Math.max(a.row, b.row),
    minCol: Math.min(a.col, b.col),
    maxCol: Math.max(a.col, b.col),
  };
}

function rangeArea(range) {
  const bounds = parseRangeBounds(range);
  return (bounds.maxRow - bounds.minRow + 1) * (bounds.maxCol - bounds.minCol + 1);
}

function parseRevisionTiles(text) {
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  const users = json.userMap ?? {};
  const revisions = (json.tileInfo ?? [])
    .filter((tile) => Number.isInteger(tile.end))
    .map((tile) => ({
      revision: tile.end,
      range: { start: tile.start, end: tile.end },
      timestamp: Number.isFinite(tile.endMillis) ? new Date(tile.endMillis).toISOString() : null,
      authors: (tile.users ?? []).map((id) => users[id]?.name ?? id),
      name: tile.name ?? null,
      expandable: tile.expandable === true,
    }))
    .sort((a, b) => b.revision - a.revision);
  return { firstRevision: json.firstRev ?? null, revisions };
}

function normalizeCellValue(value) {
  return value.replace(/\u00a0/g, ' ').trim();
}

function parseSnapshotCells(html) {
  const $ = load(html);
  const cells = new Map();
  $('tr').each((_, row) => {
    const header = $(row).find('th[id]').first();
    const rowMatch = /R(\d+)$/.exec($(header).attr('id') ?? '');
    if (!rowMatch) return;
    const rowNumber = Number(rowMatch[1]) + 1;
    let col = 0;
    $(row).find('td').each((__, cell) => {
      const $cell = $(cell);
      const colspan = Math.max(1, Number($cell.attr('colspan') ?? 1));
      let value = '';
      const checkbox = $cell.find('use[href*="checked-checkbox-id"]').attr('href');
      if (checkbox) value = checkbox.includes('unchecked') ? 'FALSE' : 'TRUE';
      else {
        const copy = $cell.clone();
        copy.find('br').replaceWith('\n');
        value = normalizeCellValue(copy.text());
      }
      if (value !== '') cells.set(`${columnName(col)}${rowNumber}`, value);
      col += colspan;
    });
  });
  return cells;
}

async function fetchRevisionTiles() {
  const res = await browserHttp('revision_tiles', {});
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`revision tiles ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return parseRevisionTiles(res.text);
}

async function fetchRevisionSnapshot(revision) {
  const res = await browserHttp('revision_snapshot', { revision, sid });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`revision ${revision} snapshot ${res.status}`);
  }
  return parseSnapshotCells(res.text);
}

function revisionInfo(tiles, revision) {
  const tile = tiles.revisions.find((item) => revision >= item.range.start && revision <= item.range.end);
  return {
    revision,
    timestamp: tile?.timestamp ?? null,
    authors: tile?.authors ?? [],
    range: tile?.range ?? null,
    name: tile?.name ?? null,
  };
}

async function getSelection(includeValues) {
  const selection = await browserRequest('selection', {});
  let values = null;
  let valuesError = null;
  if (includeValues && selection.range) {
    try {
      if (selection.range.includes(',') || rangeArea(selection.range) > 2000) {
        valuesError = 'Selection is too large or non-rectangular; use read_range for its contents.';
      } else {
        values = await readRange(selection.range);
      }
    } catch (error) {
      valuesError = String(error.message ?? error);
    }
  }
  return { ...selection, values, ...(valuesError ? { valuesError } : {}) };
}

async function listRevisions(limit) {
  const tiles = await fetchRevisionTiles();
  return {
    firstRevision: tiles.firstRevision,
    total: tiles.revisions.length,
    revisions: tiles.revisions.slice(0, limit),
  };
}

async function diffRevisions({ fromRevision, toRevision, range, maxChanges }) {
  for (const [name, value] of [['fromRevision', fromRevision], ['toRevision', toRevision]]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const bounds = range ? parseRangeBounds(range) : null;
  if (fromRevision === toRevision) {
    const tiles = await fetchRevisionTiles();
    return {
      from: revisionInfo(tiles, fromRevision),
      to: revisionInfo(tiles, toRevision),
      range: range ?? null,
      summary: { changed: 0, added: 0, removed: 0, returned: 0, truncated: false },
      changes: [],
    };
  }

  const [tiles, beforeCells, afterCells] = await Promise.all([
    fetchRevisionTiles(),
    fetchRevisionSnapshot(fromRevision),
    fetchRevisionSnapshot(toRevision),
  ]);
  const keys = new Set([...beforeCells.keys(), ...afterCells.keys()]);
  const all = [];
  let added = 0;
  let removed = 0;
  for (const a1 of keys) {
    const before = beforeCells.get(a1);
    const after = afterCells.get(a1);
    if (before === after) continue;
    const { row, col } = parseA1(a1);
    if (bounds && (row < bounds.minRow || row > bounds.maxRow || col < bounds.minCol || col > bounds.maxCol)) continue;
    if (before === undefined) added++;
    else if (after === undefined) removed++;
    all.push({
      row,
      col,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      cell: a1,
      before: before ?? null,
      after: after ?? null,
    });
  }
  all.sort((a, b) => a.row - b.row || a.col - b.col);
  const changes = all.slice(0, maxChanges).map(({ row: _row, col: _col, ...change }) => change);
  return {
    from: revisionInfo(tiles, fromRevision),
    to: revisionInfo(tiles, toRevision),
    range: range ?? null,
    summary: {
      changed: all.length,
      added,
      removed,
      returned: changes.length,
      truncated: changes.length < all.length,
    },
    changes,
  };
}

function handleActivityEvent(event) {
  if (!event || (event.spreadsheetId && event.spreadsheetId !== cfg.spreadsheetId)) {
    return Promise.resolve();
  }
  if (event.kind === 'streamrows_batch') {
    return handleStreamBatch(event);
  }
  activityQueue = activityQueue.then(async () => {
    try {
      const tiles = await fetchRevisionTiles();
      const latest = tiles.revisions[0];
      if (!latest) return;
      if (lastActivityRevision === null) {
        lastActivityRevision = latest.revision;
        lastChannelSnapshotAt ??= latest.revision;
        return;
      }
      if (latest.revision <= lastActivityRevision) return;

      const fromRevision = lastActivityRevision;
      const diff = await diffRevisions({
        fromRevision,
        toRevision: latest.revision,
        maxChanges: activity.maxChangesPerEvent,
      });
      lastActivityRevision = latest.revision;
      if (diff.summary.changed === 0) return;

      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        detectedAt: new Date().toISOString(),
        revision: latest.revision,
        fromRevision,
        authors: latest.authors,
        summary: diff.summary,
        changes: diff.changes,
        source: 'streamrows-trigger',
      });
    } catch (error) {
      if (event.kind === 'bridge_connected') return;
      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        kind: 'error',
        message: String(error.message ?? error),
      });
    }
  });
  return activityQueue;
}

function handleStreamBatch(event) {
  const snapshotAt = Number(event.snapshotAt);
  if (!Number.isInteger(snapshotAt) || !Array.isArray(event.requests) || !event.requests.length) {
    return Promise.resolve();
  }
  activityQueue = activityQueue.then(async () => {
    try {
      if (lastChannelSnapshotAt === null) {
        try {
          const tiles = await fetchRevisionTiles();
          const latest = tiles.revisions[0];
          if (latest) {
            lastActivityRevision ??= latest.revision;
            lastChannelSnapshotAt = latest.revision;
          }
        } catch {}
        lastChannelSnapshotAt ??= snapshotAt;
      }
      if (snapshotAt <= lastChannelSnapshotAt) return;

      const changes = new Map();
      const ranges = [];
      for (const request of event.requests.slice(0, 20)) {
        const response = await browserRequest('stream_fetch', {
          url: request.url,
          body: request.body,
        });
        if (response.status !== 200) continue;
        const decoded = decodeStreamRows(response.text);
        ranges.push(...decoded.ranges);
        for (const change of decoded.changes) changes.set(change.cell, change.value);
      }
      lastChannelSnapshotAt = snapshotAt;
      if (!changes.size) return;

      const channelChanges = [...changes].map(([cell, value]) => ({ cell, value }));
      let latest = null;
      let diff = null;
      try {
        const tiles = await fetchRevisionTiles();
        latest = tiles.revisions[0] ?? null;
      } catch {}
      if (latest && lastActivityRevision === null) lastActivityRevision = latest.revision;
      if (latest && lastActivityRevision !== null && latest.revision > lastActivityRevision) {
        diff = await diffRevisions({
          fromRevision: lastActivityRevision,
          toRevision: latest.revision,
          maxChanges: activity.maxChangesPerEvent,
        });
        lastActivityRevision = latest.revision;
      }

      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        detectedAt: new Date().toISOString(),
        revision: latest?.revision ?? snapshotAt,
        fromRevision: diff?.from.revision ?? null,
        authors: latest?.authors ?? [],
        summary: diff?.summary ?? {
          changed: channelChanges.length,
          added: 0,
          removed: 0,
          returned: channelChanges.length,
          truncated: false,
        },
        changes: diff?.changes ?? [],
        channel: { snapshotAt, ranges, changes: channelChanges },
        source: 'streamrows',
      });
    } catch (error) {
      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        kind: 'error',
        message: String(error.message ?? error),
      });
    }
  });
  return activityQueue;
}

function getActivity({ limit, since }) {
  let sinceTime = null;
  if (since) {
    sinceTime = Date.parse(since);
    if (!Number.isFinite(sinceTime)) throw new Error('since must be an ISO timestamp');
  }
  const listed = activity.list({ limit, sinceTime });
  return {
    trackingRevision: lastActivityRevision,
    total: listed.total,
    limits: activity.limits,
    sizeBytes: activity.sizeBytes,
    events: listed.events,
  };
}

async function readRange(range) {
  const res = await browserHttp('read', { range });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`gviz ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return parseCsv(res.text);
}

// --- write via /save ---
async function writeCells(edits) {
  for (const e of edits) {
    if (typeof e.a1 !== 'string') throw new Error('each edit needs a1');
    if (typeof e.value !== 'string' && typeof e.value !== 'number')
      throw new Error(`value for ${e.a1} must be string or number`);
  }
  reqId++;
  const bundles = buildBundles(cfg.gid, sid, edits, reqId);
  const res = await browserHttp('write', { sid, bundles, rev });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`save ${res.status}: ${res.text.slice(0, 300)}`);
  }
  try {
    const json = JSON.parse(res.text.replace(/^\)\]\}'\n?/, ''));
    rev = Math.max(rev, ...(json.revisionRanges ?? []).flat(), json.metadata?.serverRevision ?? 0);
  } catch {}
  saveSession();
  return { written: edits.length, rev };
}

const tools = {
  read_range: {
    description: 'Read a range (A1, e.g. "A1:I50" or "H10:I10") as rows of strings via gviz. Omit range for the whole sheet.',
    inputSchema: { type: 'object', properties: { range: { type: 'string' } } },
    run: async ({ range }) => ({ rows: await readRange(range) }),
  },
  write_cells: {
    description:
      'Write values to specific cells in one atomic request. Each edit is {a1, value}; value is a string or number. ' +
      'Only the named cells change; concurrent edits elsewhere are preserved (server-side OT). Formulas are NOT supported.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a1: { type: 'string' }, value: {} },
            required: ['a1', 'value'],
          },
        },
      },
      required: ['edits'],
    },
    run: ({ edits }) => writeCells(edits),
  },
  clear_cells: {
    description:
      'Blank the given cells in one atomic request (sets them to empty string). cells is a list of A1 refs. ' +
      'Note: this is an empty-string blank, not a true content-delete.',
    inputSchema: {
      type: 'object',
      properties: { cells: { type: 'array', items: { type: 'string' } } },
      required: ['cells'],
    },
    run: ({ cells }) => writeCells(cells.map((a1) => ({ a1, value: '' }))),
  },
  get_selection: {
    description:
      'Get the A1 range currently selected in the open Sheets tab, its values (up to 2000 cells), and visible ' +
      'collaborators with active/inactive status. The local selection is UI state, so it comes from the tab.',
    inputSchema: {
      type: 'object',
      properties: { includeValues: { type: 'boolean', default: true } },
    },
    run: ({ includeValues = true }) => getSelection(includeValues),
  },
  list_revisions: {
    description:
      'List revision versions newest first. Each entry has the end revision to pass to diff_revisions, the covered ' +
      'revision range, ISO timestamp, author names, and any version name.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 1500, default: 50 } },
    },
    run: ({ limit = 50 }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error('limit must be 1..1500');
      return listRevisions(limit);
    },
  },
  diff_revisions: {
    description:
      'Compare cell values between two revisions and return AI-friendly changes: [{cell, before, after, kind}]. ' +
      'Use revision numbers from list_revisions; optionally restrict to an A1 range.',
    inputSchema: {
      type: 'object',
      properties: {
        fromRevision: { type: 'integer', minimum: 1 },
        toRevision: { type: 'integer', minimum: 1 },
        range: { type: 'string', description: 'Optional A1 range, e.g. A1:H50' },
        maxChanges: { type: 'integer', minimum: 1, maximum: 5000, default: 200 },
      },
      required: ['fromRevision', 'toRevision'],
    },
    run: ({ fromRevision, toRevision, range, maxChanges = 200 }) => {
      if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 5000) {
        throw new Error('maxChanges must be 1..5000');
      }
      return diffRevisions({ fromRevision, toRevision, range, maxChanges });
    },
  },
  get_activity: {
    description:
      'Return the in-memory activity log captured from Sheets collaboration traffic. Events contain the revision, ' +
      'authors, change summary, and exact {cell, before, after, kind} changes. Limits are configurable via activity ' +
      'maxEvents, maxChangesPerEvent, and maxMemoryMb. Use since (ISO time) to poll for new events.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, default: 50 },
        since: { type: 'string', description: 'ISO timestamp; return events at or after it' },
      },
    },
    run: ({ limit = 50, since }) => {
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
      return getActivity({ limit, since });
    },
  },
};

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'gsheets-session', version: '0.5.0' },
      };
    case 'ping': return {};
    case 'tools/list':
      return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    case 'tools/call': {
      const tool = tools[msg.params.name];
      if (!tool) throw Object.assign(new Error(`unknown tool ${msg.params.name}`), { code: -32602 });
      try {
        const out = await tool.run(msg.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: String(e.message) }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');

// Serialize requests: writes mutate shared rev/reqId and must not interleave.
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  queue = queue.then(async () => {
    try { send({ id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ id: msg.id, error: { code: e.code ?? -32603, message: String(e.message) } }); }
  });
});
input.on('close', () => bridge.close());
