import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from '@bos/db';
import { ClamdClient } from '../../src/platform/documents/clamd.client';
import { assertTarget, createCompany, ensureStorageRoot, PerfDataError, scope } from './company';
import { cleanup } from './cleanup';
import { generate, fullSizes, manifest } from './generate';

async function main() {
  const config = process.env;
  const url = config['BOS_PERF_DB_URL'];
  const storage = config['BOS_PERF_STORAGE_ROOT'];
  if (!url || !storage) throw new PerfDataError('Set BOS_PERF_DB_URL and BOS_PERF_STORAGE_ROOT');
  assertTarget(url, config['NODE_ENV']);
  const command = process.argv[2];
  if (!['create', 'load', 'cleanup'].includes(command ?? ''))
    throw new PerfDataError('Choose create, load or cleanup');
  const handle = createDb(url, { max: 5 });
  const { pool } = handle;
  const lock = await pool.connect();
  try {
    // One runner at a time, including cleanup, so a retry cannot race another generator.
    const r = await lock.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('bos-perf-data')) locked`,
    );
    if (!r.rows[0]?.locked) throw new PerfDataError('Another perf data command is running');
    await ensureStorageRoot(pool, storage);
    if (command === 'cleanup') {
      await cleanup(pool, storage);
      return;
    }
    if (command === 'create') await createCompany(pool, fullSizes.customers);
    else {
      const scanner = new ClamdClient({
        host: config['BOS_PERF_CLAMD_HOST'] ?? 'localhost',
        port: Number(config['BOS_PERF_CLAMD_PORT'] ?? 3310),
      });
      if (!(await scanner.ping())) throw new PerfDataError('Local ClamAV scanner unavailable');
      await generate(handle, fullSizes, storage, scanner);
    }
    const path = resolve(config['BOS_PERF_MANIFEST'] ?? resolve(storage, 'perf-manifest.json'));
    await writeFile(`${path}.tmp`, JSON.stringify(await manifest(pool), null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    console.log(`Perf data manifest written for ${scope.organizationId}`);
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('bos-perf-data'))`);
    lock.release();
    await handle.close();
  }
}
main().catch((error: unknown) => {
  // Never print connection URLs or driver detail containing credentials.
  if (error instanceof PerfDataError) console.error('Perf data command failed:', error.message);
  else {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    console.error(
      'Perf data command failed:',
      error instanceof Error ? error.name : 'unknown error',
      typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : '',
    );
  }
  process.exitCode = 1;
});
