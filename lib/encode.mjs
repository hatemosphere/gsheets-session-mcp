// Encoder for Google Sheets' internal /save mutation protocol (strings & numbers).
// Reverse-engineered from captured edits; undocumented, may break on Google updates.

const EDIT_CMD = 21299578;      // apply cell edit
const CONTENT_CMD = 132274236;  // set cell contents (value)
const FORMAT_BLOCK = [null, [[null, 513, [0], null, null, null, null, null, null, null, null, 0]]];

// value -> contents array
function contents(value) {
  if (typeof value === 'number') return [CONTENT_CMD, 3, [3, null, value], null, null, 0];
  if (typeof value === 'string') {
    if (value.startsWith('=')) throw new Error('formulas not supported (compiled bytecode); pass a literal string/number');
    return [CONTENT_CMD, 3, [2, value], null, null, 0];
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

// A1 like "H4" -> {row, col} 0-based
export function parseA1(a1) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(a1.trim());
  if (!m) throw new Error(`bad A1: ${a1}`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

// one single-cell edit command
export function cellEditCommand(gid, a1, value) {
  const { row, col } = parseA1(a1);
  const inner = [
    [String(gid), row, row + 1, col, col + 1],
    contents(value),
    FORMAT_BLOCK,
  ];
  return [EDIT_CMD, JSON.stringify(inner)];
}

// edits: [{a1, value}, ...] -> bundles form-field string
export function buildBundles(gid, sid, edits, reqId) {
  const commands = edits.map((e) => cellEditCommand(gid, e.a1, e.value));
  return JSON.stringify([{ commands, sid, reqId }]);
}
