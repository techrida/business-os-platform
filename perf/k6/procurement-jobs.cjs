// BullMQ stream IDs carry the queue server's millisecond clock for both events.
function jobDurations(events, name) {
  const queued = new Map();
  const durations = [];
  for (const [id, fields] of events) {
    const event = {};
    for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
    const ms = Number(id.split('-')[0]);
    if (event.event === 'added' && event.name === name) queued.set(event.jobId, ms);
    if (event.event === 'completed' && queued.has(event.jobId)) {
      if (name === 'docs.scan' && event.returnvalue !== '"clean"') continue;
      durations.push(ms - queued.get(event.jobId));
      queued.delete(event.jobId);
    }
  }
  return { pending: queued.size, durations: durations.sort((a, b) => a - b) };
}
module.exports = { jobDurations };

// Read on the disposable worker so its ordinary queue connection stays inside Compose.
if (process.argv[1] === '-') {
  const Redis = require('ioredis');
  const redis = new Redis(process.env.VALKEY_URL);
  async function measure() {
    const since = Date.parse(process.argv[2]);
    for (const [queue, name] of [
      ['docs.scan', 'docs.scan'],
      ['purchase-order.render', 'purchase-order.render.one'],
    ]) {
      const deadline = Date.now() + 30000;
      let result;
      do {
        const events = await redis.xrange('bull:' + queue + ':events', since + '-0', '+');
        result = jobDurations(events, name);
        if (!result.pending) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      const { pending, durations } = result;
      const values = [0.5, 0.95, 0.99].map((p) => {
        const at = p * (durations.length - 1);
        const lower = Math.floor(at);
        return durations.length
          ? (
              durations[lower] +
              (at - lower) * (durations[Math.ceil(at)] - durations[lower])
            ).toFixed(1)
          : '';
      });
      console.log('Measured queue time (ms), job, completed, pending, p50, p95, p99');
      console.log([name, durations.length, pending, ...values].join(', '));
      if (pending || !durations.length) process.exitCode = 1;
    }
  }
  measure()
    .catch(() => {
      console.error('Could not read procurement job timings');
      process.exitCode = 1;
    })
    .finally(() => redis.disconnect());
}
