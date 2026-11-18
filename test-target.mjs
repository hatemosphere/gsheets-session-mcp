import assert from 'node:assert/strict';
import { parseSheetRef } from './lib/target.mjs';

const ID = '1AbcDefGhiJklMnoPqrStuVwxyz0123456789';

// bare id
assert.deepEqual(parseSheetRef(ID), { spreadsheetId: ID, gid: null });

// edit url with gid in hash
assert.deepEqual(
  parseSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1234567890`),
  { spreadsheetId: ID, gid: '1234567890' },
);

// /u/1/ account-scoped url, gid in query
assert.deepEqual(
  parseSheetRef(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?gid=0#gid=0`),
  { spreadsheetId: ID, gid: '0' },
);

// no gid
assert.deepEqual(
  parseSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit`),
  { spreadsheetId: ID, gid: null },
);

for (const bad of ['', '   ', 'not a url', 'short', 'https://example.com/x']) {
  assert.throws(() => parseSheetRef(bad), /spreadsheet|parse/, `should reject: ${JSON.stringify(bad)}`);
}

console.log('PASS target parser');
