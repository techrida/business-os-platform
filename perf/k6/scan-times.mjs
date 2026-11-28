// BullMQ records "added" and "completed" in one Valkey stream using server timestamps.
import { pathToFileURL } from 'node:url';
import { percentile } from './percentile.cjs';

export function scanTimes(events, versionIds) {
  const selected = versionIds && new Set(versionIds);
  const queued = new Map();
  const durations = [];
  for (const [id, fields] of events) {
    const event = {};
    for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
    if (selected && !selected.has(event.jobId)) continue;
    const time = Number(id.split('-')[0]);
    if (event.event === 'added') queued.set(event.jobId, time);
    if (event.event === 'completed' && queued.has(event.jobId)) {
      durations.push(time - queued.get(event.jobId));
      queued.delete(event.jobId);
    }
  }
  if (!selected && queued.size) throw new Error('Proof scan queue has incomplete jobs');
  if (!selected && !durations.length) throw new Error('No jobs completed in the proof scan queue');
  return durations.sort((a, b) => a - b);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const sorted = scanTimes(JSON.parse(data));
  console.log(
    [
      'proof-scan-queued-to-done',
      sorted.length,
      ...[50, 95, 99].map((p) => percentile(sorted, p).toFixed(1)),
    ].join(', '),
  );
}
