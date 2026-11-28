import assert from 'node:assert/strict';
import test from 'node:test';
import { scanTimes } from './scan-times.mjs';

test('matches queued to completed for the selected uploads, including a retried scan', () => {
  const event = (ms, type, id) => [ms + '-0', ['event', type, 'jobId', id]];
  const events = [
    event(100, 'added', 'a'),
    event(105, 'added', 'b'),
    event(110, 'failed', 'a'),
    event(120, 'completed', 'b'),
    event(150, 'completed', 'a'),
  ];
  assert.deepEqual(scanTimes(['a', 'b'], events), [15, 50]);
  assert.deepEqual(scanTimes(['a', 'missing'], events), [50]);
  assert.deepEqual(scanTimes(['missing'], events), []);
});
