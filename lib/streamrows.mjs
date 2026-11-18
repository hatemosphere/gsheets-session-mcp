function parseEnvelope(text) {
  const newline = text.indexOf('\n');
  const rest = newline >= 0 ? text.slice(newline + 1) : text;
  const match = /^\d+&\d+&/.exec(rest);
  if (!match) throw new Error('not a StreamRows envelope');
  return JSON.parse(rest.slice(match[0].length));
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function scalar(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 2 && raw[0] === 2 && typeof raw[1] === 'string') return raw[1];
    if (raw.length === 1 && raw[0] && typeof raw[0] === 'object') return scalar(raw[0]);
    return raw[1] ?? null;
  }
  if (typeof raw === 'object') {
    if ('3' in raw) return raw['3'];
    if ('2' in raw) return scalar(raw['2']);
    if ('1' in raw && raw['1'] === 0 && Object.keys(raw).length === 1) return null;
    if ('1' in raw) return raw['1'];
  }
  return raw;
}

export function decodeStreamRows(text) {
  const envelope = parseEnvelope(text);
  const changes = new Map();
  const ranges = [];
  for (const snapshot of envelope.snapshot ?? []) {
    if (snapshot[0] !== 341438337) continue;
    const payload = typeof snapshot[1] === 'string' ? JSON.parse(snapshot[1]) : snapshot[1];
    const node = payload?.[0]?.['2']?.[0];
    if (!node) continue;
    const range = node['1'];
    const [gid, rowStart, rowEnd, colStart, colEnd] = range;
    ranges.push({ gid: String(gid), rowStart, rowEnd, colStart, colEnd });
    const valueSection = (node['5'] ?? []).find((section) => section[0] === 2);
    if (!valueSection) continue;
    const body = valueSection[1]?.[0];
    const columnGroups = body?.['4']?.[1] ?? [];
    for (let colOffset = 0; colOffset < columnGroups.length; colOffset++) {
      const wrappedRuns = columnGroups[colOffset]?.[0]?.['16']?.[1] ?? [];
      for (const wrapped of wrappedRuns) {
        const run = Array.isArray(wrapped) ? wrapped[0] : wrapped;
        if (!run) continue;
        const rowOffset = run['4']?.[1] ?? 0;
        const add = (index, value) => {
          if (value === null || value === undefined || value === '') return;
          const cell = columnName(colStart + colOffset) + (rowStart + rowOffset + index + 1);
          changes.set(cell, value);
        };
        if (run['4']) run['4'][0].forEach((value, index) => add(index, value));
        else if (run['2']) (run['2']?.[0]?.['1'] ?? []).forEach((value, index) => add(index, scalar(value)));
        else if (run['3']) (run['3']?.[0]?.['1'] ?? []).forEach((value, index) => add(index, value));
      }
    }
  }
  return { ranges, changes: [...changes].map(([cell, value]) => ({ cell, value })) };
}
