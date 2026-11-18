#!/usr/bin/env node
// Live writer for the Sheets internal /save protocol. Strings & numbers only.
// Reads config from ./secrets.local.json (gitignored). Usage:
//   node save-write.mjs H7=hello I7=123 "J7=some text"
// Number if the value parses as a finite number, else string.

import { readFileSync, writeFileSync } from 'node:fs';
import { buildBundles } from './lib/encode.mjs';

const CFG = './secrets.local.json';
const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const need = ['cookie', 'sid', 'token', 'ouid', 'gid', 'spreadsheetId', 'rev'];
for (const k of need) if (cfg[k] === undefined) throw new Error(`secrets.local.json missing "${k}"`);

const edits = process.argv.slice(2).map((arg) => {
  const i = arg.indexOf('=');
  if (i < 0) throw new Error(`bad edit "${arg}", expected A1=value`);
  const a1 = arg.slice(0, i);
  const raw = arg.slice(i + 1);
  const num = Number(raw);
  return { a1, value: raw !== '' && Number.isFinite(num) ? num : raw };
});
if (!edits.length) throw new Error('no edits given');

const reqId = (cfg.reqId ?? 0) + 1;
const bundles = buildBundles(cfg.gid, cfg.sid, edits, reqId);

const qs = new URLSearchParams({
  id: cfg.spreadsheetId,
  sid: cfg.sid,
  vc: '1', c: '1', w: '1', flr: '0',
  token: cfg.token,
  ouid: cfg.ouid,
  includes_info_params: 'true',
});
const url = `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/save?${qs}`;

const form = new FormData();
form.set('rev', String(cfg.rev));
form.set('bundles', bundles);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    cookie: cfg.cookie,
    origin: 'https://docs.google.com',
    referer: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit?gid=${cfg.gid}`,
    'x-same-domain': '1',
  },
  body: form,
});

const text = await res.text();
console.log('HTTP', res.status);
console.log(text.slice(0, 1000));

// Response is ")]}'\n" + JSON. New rev = highest value in revisionRanges.
try {
  const json = JSON.parse(text.replace(/^\)\]\}'\n?/, ''));
  const ranges = json.revisionRanges ?? [];
  const newRev = Math.max(cfg.rev, ...ranges.flat(), json.metadata?.serverRevision ?? 0);
  writeFileSync(CFG, JSON.stringify({ ...cfg, rev: newRev, reqId }, null, 2));
  console.log('-> advanced rev to', newRev, 'reqId', reqId);
} catch {
  writeFileSync(CFG, JSON.stringify({ ...cfg, reqId }, null, 2));
  console.log('-> could not parse response JSON; rev not advanced (bumped reqId)');
}
