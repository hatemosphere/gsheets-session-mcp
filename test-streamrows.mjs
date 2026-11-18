import assert from 'node:assert/strict';
import { decodeStreamRows } from './lib/streamrows.mjs';

const payload = [{
  '2': [{
    '1': ['0', 0, 3, 0, 3],
    '3': 3,
    '5': [
      [2, [{
        '4': [1, [
          [{ '16': [500, [[{ '4': [['Name', 'alpha'], 0], '5': 3 }]]] }],
          [{ '16': [500, [[{ '2': [{ '1': [[2, 'A1'], { '1': 3, '3': 1 }, { '1': 3, '3': 2 }] }], '5': 3 }]]] }],
          [{ '16': [500, [[{ '3': [{ '1': [42] }], '5': 3 }]]] }],
        ]],
        '5': [],
      }]],
    ],
  }],
}];
const envelope = { gridRange: ['0', 0, 1000, 0, 26], snapshot: [[341438337, payload]] };
const text = ")]}'\n0&" + JSON.stringify(envelope).length + '&' + JSON.stringify(envelope);
const decoded = decodeStreamRows(text);
assert.deepEqual(decoded.ranges, [{ gid: '0', rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 3 }]);
assert.deepEqual(decoded.changes, [
  { cell: 'A1', value: 'Name' },
  { cell: 'A2', value: 'alpha' },
  { cell: 'B1', value: 'A1' },
  { cell: 'B2', value: 1 },
  { cell: 'B3', value: 2 },
  { cell: 'C1', value: 42 },
]);

assert.throws(() => decodeStreamRows('not streamrows'), /not a StreamRows envelope/);
console.log('PASS streamrows decoder');
