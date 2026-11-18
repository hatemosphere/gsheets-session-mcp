import assert from 'node:assert/strict';
import { ActivityLog } from './lib/activity.mjs';

const change = (cell, after) => ({ kind: 'added', cell, before: null, after });
const event = (second, changes = []) => ({
  time: new Date(second * 1000).toISOString(),
  revision: second,
  summary: { changed: changes.length, added: changes.length, removed: 0, returned: changes.length, truncated: false },
  changes,
});

const eventCap = new ActivityLog({ maxEvents: 2, maxChangesPerEvent: 10, maxMemoryMb: 1 });
eventCap.push(event(1));
eventCap.push(event(2));
eventCap.push(event(3));
assert.deepEqual(eventCap.list().events.map((item) => item.revision), [2, 3]);

const changeCap = new ActivityLog({ maxEvents: 10, maxChangesPerEvent: 2, maxMemoryMb: 1 });
changeCap.push(event(1, [change('A1', 'one'), change('A2', 'two'), change('A3', 'three')]));
const capped = changeCap.list().events[0];
assert.equal(capped.changes.length, 2);
assert.equal(capped.summary.returned, 2);
assert.equal(capped.summary.truncated, true);

const memoryCap = new ActivityLog({ maxEvents: 10, maxChangesPerEvent: 100, maxMemoryMb: 0.002 });
memoryCap.push(event(1, Array.from({ length: 20 }, (_, index) => change('A' + (index + 1), 'x'.repeat(500)))));
const memoryEntry = memoryCap.list().events[0];
assert.ok(memoryCap.sizeBytes <= memoryCap.limits.maxMemoryBytes);
assert.ok(memoryEntry.changes.length < 20);
assert.equal(memoryEntry.summary.returned, memoryEntry.changes.length);
assert.equal(memoryEntry.summary.truncated, true);

const oversized = new ActivityLog({ maxEvents: 10, maxChangesPerEvent: 10, maxMemoryMb: 0.001 });
assert.equal(oversized.push({ ...event(1), huge: 'x'.repeat(5000) }), false);
assert.equal(oversized.list().total, 0);

const sinceLog = new ActivityLog({ maxEvents: 10, maxChangesPerEvent: 10, maxMemoryMb: 1 });
sinceLog.push(event(1));
sinceLog.push(event(2));
sinceLog.push(event(3));
assert.deepEqual(sinceLog.list({ sinceTime: Date.parse(event(2).time) }).events.map((item) => item.revision), [2, 3]);

console.log('PASS activity limits');
