import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from './backend-summary.mjs';

test('counts completed successful requests, preserves zero latency and flags missing flows', async () => {
  const record = (status, time) =>
    JSON.stringify({
      req: { headers: { 'x-perf-flow': 'write' } },
      res: { statusCode: status },
      responseTime: time,
    });
  const rows = await summarize(
    [record(201, 0), record(201, 100), record(400, 500), record(200, null)],
    ['write', 'missing'],
  );
  assert.deepEqual(rows, [
    { flow: 'write', n: 2, percentiles: [50, 95, 99] },
    { flow: 'missing', n: 0, percentiles: [] },
  ]);
});

test('scan queue timing includes waiting and fails on incomplete jobs', async () => {
  const { scanTimes } = await import('./scan-times.mjs');
  const event = (ms, event, jobId) => [ms + '-0', ['event', event, 'jobId', jobId]];
  const events = [event(1, 'added', 'a'), event(10, 'added', 'b'), event(31, 'completed', 'a')];
  assert.throws(() => scanTimes(events), /incomplete/);
  assert.deepEqual(scanTimes([...events, event(20, 'completed', 'b')]), [10, 30]);
  assert.throws(() => scanTimes([]), /no jobs/i);
});
