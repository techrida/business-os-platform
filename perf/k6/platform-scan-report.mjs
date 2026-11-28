// Run inside the disposable API container. Queue event IDs carry Valkey's millisecond timestamps.
import { createRequire } from 'node:module';
import { percentile } from './backend-summary.mjs';
import { scanTimes } from './scan-times.mjs';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(process.cwd() + '/package.json');
  const [since, tenant, org] = process.argv.slice(2);
  const db = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });
  const queue = new (require('ioredis'))(process.env.VALKEY_URL);
  try {
    // A user can stop polling while the worker still owns the file. Drain that fixed cohort
    // before cleanup so slow completions contribute to the worker percentiles.
    const { rows: cohort } = await db.query(
      `SELECT v.id FROM app.document_versions v JOIN app.documents d ON d.id=v.document_id AND d.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND d.organization_id=$2 AND d.owner_type='verification_case' AND v.filename='platform.pdf' AND v.created_at >= $3`,
      [tenant, org, since],
    );
    const ids = cohort.map((row) => row.id);
    const deadline = Date.now() + 15 * 60 * 1000;
    let rows;
    for (;;) {
      ({ rows } = await db.query(
        'SELECT id,status FROM app.document_versions WHERE tenant_id=$1 AND organization_id=$2 AND id = ANY($3::uuid[])',
        [tenant, org, ids],
      ));
      if (!rows.some((row) => row.status === 'quarantined') || Date.now() >= deadline) break;
      await setTimeout(5000);
    }
    const events = await queue.xrange('bull:docs.scan:events', String(Date.parse(since)), '+');
    const times = scanTimes(
      events,
      rows.filter((r) => r.status === 'clean').map((r) => r.id),
    );
    console.log('Measured queued-to-done scan time (ms): completed/reserved, p50, p95, p99');
    const values = times.length
      ? [0.5, 0.95, 0.99].map((q) => percentile(times, q).toFixed(1))
      : [];
    console.log([times.length + '/' + cohort.length, ...values].join(', '));
    if (!times.length || times.length !== cohort.length || percentile(times, 0.95) >= 10000)
      process.exitCode = 1;
  } finally {
    await db.end();
    queue.disconnect();
  }
}
