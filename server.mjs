#!/usr/bin/env node
// stdio MCP for Google Sheets via the browser-session /save protocol + gviz reads.
// The Chrome extension executes requests in an open Sheets tab, so Google
// cookies and session tokens never enter this process. No OAuth or API key.
//
// Targeting is dynamic: every tool takes an optional `spreadsheet` (full URL or
// ID) and optional `gid`. If omitted and exactly one Sheets tab is open, that
// tab is used; if several are open, the call errors and lists them. Use the
// list_sheets tool to see what is open. The only config is optional activity
// limits in ./secrets.local.json (the file itself is optional).
//
// Writes: strings & numbers only (formulas use a compiled bytecode we don't generate).

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load } from 'cheerio';
import { ActivityLog } from './lib/activity.mjs';
import { buildBundles, parseA1 } from './lib/encode.mjs';
import { decodeStreamRows } from './lib/streamrows.mjs';
import { parseSheetRef } from './lib/target.mjs';
import { BRIDGE_PORT, BrowserBridge } from './lib/bridge.mjs';

const CFG = resolve(dirname(fileURLToPath(import.meta.url)), 'secrets.local.json');
let cfg = {};
try { cfg = JSON.parse(readFileSync(CFG, 'utf8')); } catch {}

const activity = new ActivityLog(cfg.activity);
// Per-spreadsheet activity tracking: spreadsheetId -> { lastRevision, lastChannelSnapshotAt }.
const activityState = new Map();
let activityQueue = Promise.resolve();

// Per-spreadsheet save session: spreadsheetId -> { sid, rev, reqId }.
// sid is generated fresh; stale rev is tolerated (server applies OT), so none of
// this needs to persist across restarts.
const sessions = new Map();
function session(spreadsheetId) {
  let s = sessions.get(spreadsheetId);
  if (!s) { s = { sid: randomBytes(8).toString('hex'), rev: 0, reqId: 0 }; sessions.set(spreadsheetId, s); }
  return s;
}

const bridge = new BrowserBridge();
bridge.onEvent = (event) => { handleActivityEvent(event).catch(() => {}); };
await bridge.listen();
console.error(`[gsheets-session] browser bridge listening on ws://127.0.0.1:${BRIDGE_PORT}/bridge`);

// --- tab discovery / targeting ---
async function listSheets() {
  const sheets = await bridge.request('list_sheets', {});
  return Array.isArray(sheets) ? sheets : [];
}

async function resolveTarget({ spreadsheet, gid } = {}) {
  let id = null;
  let urlGid = null;
  if (spreadsheet !== undefined && spreadsheet !== null && spreadsheet !== '') {
    ({ spreadsheetId: id, gid: urlGid } = parseSheetRef(String(spreadsheet)));
  }
  const open = await listSheets();
  if (!id) {
    if (open.length === 1) id = open[0].spreadsheetId;
    else if (open.length === 0) throw new Error('No Google Sheets tab is open in Chrome. Open the sheet, then retry.');
    else throw new Error(`Several sheets are open; pass "spreadsheet" (URL or ID). Open: ${open.map((s) => `${s.spreadsheetId}${s.title ? ` (${s.title})` : ''}`).join('; ')}`);
  }
  const tab = open.find((s) => s.spreadsheetId === id);
  if (!tab) {
    const list = open.map((s) => s.spreadsheetId).join(', ') || 'none';
    throw new Error(`Spreadsheet ${id} is not open in Chrome. Open it and retry. Currently open: ${list}`);
  }
  const resolvedGid = gid !== undefined && gid !== null ? String(gid) : (urlGid ?? tab.gid ?? '0');
  return { spreadsheetId: id, gid: resolvedGid };
}

// --- bridge request helpers ---
async function browserRequest(action, params) {
  const result = await bridge.request(action, params);
  if (!result || typeof result !== 'object') throw new Error('Browser extension returned an invalid response.');
  return result;
}

async function browserHttp(action, params) {
  const result = await browserRequest(action, params);
  if (!Number.isInteger(result.status) || typeof result.text !== 'string') {
    throw new Error('Browser extension returned an invalid HTTP response.');
  }
  return result;
}

// --- helpers ---
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
  const b = parseRangeBounds(range);
  return (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
}

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

function parseRevisionTiles(text) {
  const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  const users = json.userMap ?? {};
  const revisions = (json.tileInfo ?? [])
    .filter((tile) => Number.isInteger(tile.end))
    .map((tile) => ({
      revision: tile.end,
      range: { start: tile.start, end: tile.end },
      timestamp: Number.isFinite(tile.endMillis) ? new Date(tile.endMillis).toISOString() : null,
      authors: (tile.users ?? []).map((idx) => users[idx]?.name ?? idx),
      name: tile.name ?? null,
      expandable: tile.expandable === true,
    }))
    .sort((a, b) => b.revision - a.revision);
  return { firstRevision: json.firstRev ?? null, revisions };
}

function normalizeCellValue(value) {
  return value.replace(/ /g, ' ').trim();
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

// --- reads / writes ---
async function readRange(spreadsheetId, gid, range) {
  const res = await browserHttp('read', { spreadsheetId, gid, range });
  if (res.status < 200 || res.status >= 300) throw new Error(`gviz ${res.status}: ${res.text.slice(0, 200)}`);
  return parseCsv(res.text);
}

async function writeCells(spreadsheetId, gid, edits) {
  for (const e of edits) {
    if (typeof e.a1 !== 'string') throw new Error('each edit needs a1');
    if (typeof e.value !== 'string' && typeof e.value !== 'number') throw new Error(`value for ${e.a1} must be string or number`);
  }
  const s = session(spreadsheetId);
  s.reqId++;
  const bundles = buildBundles(gid, s.sid, edits, s.reqId);
  const res = await browserHttp('write', { spreadsheetId, gid, sid: s.sid, bundles, rev: s.rev });
  if (res.status < 200 || res.status >= 300) throw new Error(`save ${res.status}: ${res.text.slice(0, 300)}`);
  try {
    const json = JSON.parse(res.text.replace(/^\)\]\}'\n?/, ''));
    s.rev = Math.max(s.rev, ...(json.revisionRanges ?? []).flat(), json.metadata?.serverRevision ?? 0);
  } catch {}
  return { spreadsheetId, written: edits.length, rev: s.rev };
}

// --- selection ---
async function getSelection(spreadsheetId, gid, includeValues) {
  const selection = await browserRequest('selection', { spreadsheetId, gid });
  let values = null;
  let valuesError = null;
  if (includeValues && selection.range) {
    try {
      if (selection.range.includes(',') || rangeArea(selection.range) > 2000) {
        valuesError = 'Selection is too large or non-rectangular; use read_range for its contents.';
      } else {
        values = await readRange(spreadsheetId, gid, selection.range);
      }
    } catch (error) {
      valuesError = String(error.message ?? error);
    }
  }
  return { spreadsheetId, ...selection, values, ...(valuesError ? { valuesError } : {}) };
}

// --- revisions ---
async function fetchRevisionTiles(spreadsheetId) {
  const res = await browserHttp('revision_tiles', { spreadsheetId });
  if (res.status < 200 || res.status >= 300) throw new Error(`revision tiles ${res.status}: ${res.text.slice(0, 200)}`);
  return parseRevisionTiles(res.text);
}

async function fetchRevisionSnapshot(spreadsheetId, gid, revision) {
  const res = await browserHttp('revision_snapshot', { spreadsheetId, gid, revision, sid: session(spreadsheetId).sid });
  if (res.status < 200 || res.status >= 300) throw new Error(`revision ${revision} snapshot ${res.status}`);
  return parseSnapshotCells(res.text);
}

function revisionInfo(tiles, revision) {
  const tile = tiles.revisions.find((item) => revision >= item.range.start && revision <= item.range.end);
  return { revision, timestamp: tile?.timestamp ?? null, authors: tile?.authors ?? [], range: tile?.range ?? null, name: tile?.name ?? null };
}

async function listRevisions(spreadsheetId, limit) {
  const tiles = await fetchRevisionTiles(spreadsheetId);
  return { spreadsheetId, firstRevision: tiles.firstRevision, total: tiles.revisions.length, revisions: tiles.revisions.slice(0, limit) };
}

async function diffRevisions(spreadsheetId, gid, { fromRevision, toRevision, range, maxChanges }) {
  for (const [name, value] of [['fromRevision', fromRevision], ['toRevision', toRevision]]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const bounds = range ? parseRangeBounds(range) : null;
  if (fromRevision === toRevision) {
    const tiles = await fetchRevisionTiles(spreadsheetId);
    return {
      spreadsheetId,
      from: revisionInfo(tiles, fromRevision),
      to: revisionInfo(tiles, toRevision),
      range: range ?? null,
      summary: { changed: 0, added: 0, removed: 0, returned: 0, truncated: false },
      changes: [],
    };
  }

  const [tiles, beforeCells, afterCells] = await Promise.all([
    fetchRevisionTiles(spreadsheetId),
    fetchRevisionSnapshot(spreadsheetId, gid, fromRevision),
    fetchRevisionSnapshot(spreadsheetId, gid, toRevision),
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
    all.push({ row, col, kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', cell: a1, before: before ?? null, after: after ?? null });
  }
  all.sort((a, b) => a.row - b.row || a.col - b.col);
  const changes = all.slice(0, maxChanges).map(({ row: _r, col: _c, ...change }) => change);
  return {
    spreadsheetId,
    from: revisionInfo(tiles, fromRevision),
    to: revisionInfo(tiles, toRevision),
    range: range ?? null,
    summary: { changed: all.length, added, removed, returned: changes.length, truncated: changes.length < all.length },
    changes,
  };
}

// --- activity monitor (per spreadsheet) ---
function activityStateFor(spreadsheetId) {
  let s = activityState.get(spreadsheetId);
  if (!s) { s = { lastRevision: null, lastChannelSnapshotAt: null }; activityState.set(spreadsheetId, s); }
  return s;
}

async function activityGid(spreadsheetId) {
  try {
    const open = await listSheets();
    return open.find((s) => s.spreadsheetId === spreadsheetId)?.gid ?? '0';
  } catch { return '0'; }
}

function handleActivityEvent(event) {
  const spreadsheetId = event?.spreadsheetId;
  if (!spreadsheetId) return Promise.resolve();
  if (event.kind === 'streamrows_batch') return handleStreamBatch(event);

  activityQueue = activityQueue.then(async () => {
    const state = activityStateFor(spreadsheetId);
    try {
      const gid = await activityGid(spreadsheetId);
      const tiles = await fetchRevisionTiles(spreadsheetId);
      const latest = tiles.revisions[0];
      if (!latest) return;
      if (state.lastRevision === null) {
        state.lastRevision = latest.revision;
        state.lastChannelSnapshotAt ??= latest.revision;
        return;
      }
      if (latest.revision <= state.lastRevision) return;

      const fromRevision = state.lastRevision;
      const diff = await diffRevisions(spreadsheetId, gid, { fromRevision, toRevision: latest.revision, maxChanges: activity.maxChangesPerEvent });
      state.lastRevision = latest.revision;
      if (diff.summary.changed === 0) return;

      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        detectedAt: new Date().toISOString(),
        spreadsheetId,
        revision: latest.revision,
        fromRevision,
        authors: latest.authors,
        summary: diff.summary,
        changes: diff.changes,
        source: 'streamrows-trigger',
      });
    } catch (error) {
      if (event.kind === 'bridge_connected') return;
      activity.push({ time: new Date(event.at ?? Date.now()).toISOString(), spreadsheetId, kind: 'error', message: String(error.message ?? error) });
    }
  });
  return activityQueue;
}

function handleStreamBatch(event) {
  const spreadsheetId = event.spreadsheetId;
  const snapshotAt = Number(event.snapshotAt);
  if (!Number.isInteger(snapshotAt) || !Array.isArray(event.requests) || !event.requests.length) return Promise.resolve();

  activityQueue = activityQueue.then(async () => {
    const state = activityStateFor(spreadsheetId);
    try {
      if (state.lastChannelSnapshotAt === null) {
        try {
          const tiles = await fetchRevisionTiles(spreadsheetId);
          const latest = tiles.revisions[0];
          if (latest) {
            state.lastRevision ??= latest.revision;
            state.lastChannelSnapshotAt = latest.revision;
          }
        } catch {}
        state.lastChannelSnapshotAt ??= snapshotAt;
      }
      if (snapshotAt <= state.lastChannelSnapshotAt) return;

      const changes = new Map();
      const ranges = [];
      for (const request of event.requests.slice(0, 20)) {
        const response = await browserRequest('stream_fetch', { spreadsheetId, url: request.url, body: request.body });
        if (response.status !== 200) continue;
        const decoded = decodeStreamRows(response.text);
        ranges.push(...decoded.ranges);
        for (const change of decoded.changes) changes.set(change.cell, change.value);
      }
      state.lastChannelSnapshotAt = snapshotAt;
      if (!changes.size) return;

      const channelChanges = [...changes].map(([cell, value]) => ({ cell, value }));
      let latest = null;
      let diff = null;
      try {
        const tiles = await fetchRevisionTiles(spreadsheetId);
        latest = tiles.revisions[0] ?? null;
      } catch {}
      if (latest && state.lastRevision === null) state.lastRevision = latest.revision;
      if (latest && state.lastRevision !== null && latest.revision > state.lastRevision) {
        const gid = await activityGid(spreadsheetId);
        diff = await diffRevisions(spreadsheetId, gid, { fromRevision: state.lastRevision, toRevision: latest.revision, maxChanges: activity.maxChangesPerEvent });
        state.lastRevision = latest.revision;
      }

      activity.push({
        time: new Date(event.at ?? Date.now()).toISOString(),
        detectedAt: new Date().toISOString(),
        spreadsheetId,
        revision: latest?.revision ?? snapshotAt,
        fromRevision: diff?.from.revision ?? null,
        authors: latest?.authors ?? [],
        summary: diff?.summary ?? { changed: channelChanges.length, added: 0, removed: 0, returned: channelChanges.length, truncated: false },
        changes: diff?.changes ?? [],
        channel: { snapshotAt, ranges, changes: channelChanges },
        source: 'streamrows',
      });
    } catch (error) {
      activity.push({ time: new Date(event.at ?? Date.now()).toISOString(), spreadsheetId, kind: 'error', message: String(error.message ?? error) });
    }
  });
  return activityQueue;
}

function getActivity({ spreadsheetId, limit, since }) {
  let sinceTime = null;
  if (since) {
    sinceTime = Date.parse(since);
    if (!Number.isFinite(sinceTime)) throw new Error('since must be an ISO timestamp');
  }
  const listed = activity.list({ limit: spreadsheetId ? undefined : limit, sinceTime });
  let events = listed.events;
  let total = listed.total;
  if (spreadsheetId) {
    events = events.filter((e) => e.spreadsheetId === spreadsheetId);
    total = events.length;
    events = events.slice(-limit);
  }
  return {
    tracking: Object.fromEntries([...activityState].map(([id, s]) => [id, s.lastRevision])),
    total,
    limits: activity.limits,
    sizeBytes: activity.sizeBytes,
    events,
  };
}

const SPREADSHEET_PROP = { type: 'string', description: 'Target sheet: full URL or spreadsheet ID. Omit to use the only open Sheets tab.' };
const GID_PROP = { type: 'string', description: 'Sheet tab gid. Omit to use the gid from the URL or the open tab.' };

const tools = {
  list_sheets: {
    description: 'List the Google Sheets tabs currently open in Chrome, each with spreadsheetId, gid, title, url, and whether the tab is active. Use these to target the other tools.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ sheets: await listSheets() }),
  },
  read_range: {
    description: 'Read a range (A1, e.g. "A1:I50") as rows of strings via gviz. Omit range for the whole sheet.',
    inputSchema: { type: 'object', properties: { spreadsheet: SPREADSHEET_PROP, gid: GID_PROP, range: { type: 'string' } } },
    run: async ({ spreadsheet, gid, range }) => {
      const t = await resolveTarget({ spreadsheet, gid });
      return { spreadsheetId: t.spreadsheetId, gid: t.gid, rows: await readRange(t.spreadsheetId, t.gid, range) };
    },
  },
  write_cells: {
    description:
      'Write values to specific cells in one atomic request. Each edit is {a1, value}; value is a string or number. ' +
      'Only the named cells change; concurrent edits elsewhere are preserved (server-side OT). Formulas are NOT supported.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: SPREADSHEET_PROP,
        gid: GID_PROP,
        edits: { type: 'array', items: { type: 'object', properties: { a1: { type: 'string' }, value: {} }, required: ['a1', 'value'] } },
      },
      required: ['edits'],
    },
    run: async ({ spreadsheet, gid, edits }) => {
      const t = await resolveTarget({ spreadsheet, gid });
      return writeCells(t.spreadsheetId, t.gid, edits);
    },
  },
  clear_cells: {
    description: 'Blank the given cells in one atomic request (sets them to empty string). Note: empty-string blank, not a true content-delete.',
    inputSchema: {
      type: 'object',
      properties: { spreadsheet: SPREADSHEET_PROP, gid: GID_PROP, cells: { type: 'array', items: { type: 'string' } } },
      required: ['cells'],
    },
    run: async ({ spreadsheet, gid, cells }) => {
      const t = await resolveTarget({ spreadsheet, gid });
      return writeCells(t.spreadsheetId, t.gid, cells.map((a1) => ({ a1, value: '' })));
    },
  },
  get_selection: {
    description: 'Get the A1 range currently selected in the open Sheets tab, its values (up to 2000 cells), and visible collaborators with active/inactive status.',
    inputSchema: { type: 'object', properties: { spreadsheet: SPREADSHEET_PROP, gid: GID_PROP, includeValues: { type: 'boolean', default: true } } },
    run: async ({ spreadsheet, gid, includeValues = true }) => {
      const t = await resolveTarget({ spreadsheet, gid });
      return getSelection(t.spreadsheetId, t.gid, includeValues);
    },
  },
  list_revisions: {
    description: 'List revision versions newest first. Each entry has the end revision to pass to diff_revisions, the covered revision range, ISO timestamp, author names, and any version name.',
    inputSchema: { type: 'object', properties: { spreadsheet: SPREADSHEET_PROP, limit: { type: 'integer', minimum: 1, maximum: 1500, default: 50 } } },
    run: async ({ spreadsheet, limit = 50 }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error('limit must be 1..1500');
      const t = await resolveTarget({ spreadsheet });
      return listRevisions(t.spreadsheetId, limit);
    },
  },
  diff_revisions: {
    description: 'Compare cell values between two revisions and return AI-friendly changes: [{cell, before, after, kind}]. Use revision numbers from list_revisions; optionally restrict to an A1 range.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: SPREADSHEET_PROP,
        gid: GID_PROP,
        fromRevision: { type: 'integer', minimum: 1 },
        toRevision: { type: 'integer', minimum: 1 },
        range: { type: 'string', description: 'Optional A1 range, e.g. A1:H50' },
        maxChanges: { type: 'integer', minimum: 1, maximum: 5000, default: 200 },
      },
      required: ['fromRevision', 'toRevision'],
    },
    run: async ({ spreadsheet, gid, fromRevision, toRevision, range, maxChanges = 200 }) => {
      if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 5000) throw new Error('maxChanges must be 1..5000');
      const t = await resolveTarget({ spreadsheet, gid });
      return diffRevisions(t.spreadsheetId, t.gid, { fromRevision, toRevision, range, maxChanges });
    },
  },
  get_activity: {
    description:
      'Return the in-memory activity log captured from Sheets collaboration traffic across open tabs. Events contain spreadsheetId, revision, authors, change summary, and exact {cell, before, after, kind} changes. Pass spreadsheet to filter to one sheet, and since (ISO time) to poll for new events.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: SPREADSHEET_PROP,
        limit: { type: 'integer', minimum: 1, default: 50 },
        since: { type: 'string', description: 'ISO timestamp; return events at or after it' },
      },
    },
    run: async ({ spreadsheet, limit = 50, since }) => {
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
      let spreadsheetId;
      if (spreadsheet) spreadsheetId = parseSheetRef(String(spreadsheet)).spreadsheetId;
      return getActivity({ spreadsheetId, limit, since });
    },
  },
};

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gsheets-session', version: '0.6.0' } };
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

// Serialize requests: per-sheet rev/reqId must not interleave.
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
