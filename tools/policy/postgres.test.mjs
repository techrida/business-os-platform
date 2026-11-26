// Policy test (U1-06): Postgres settings for measurement, private logs and SSDs.
// Run: node --test tools/policy/postgres.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** `key = value` lines of postgresql.conf. The last assignment wins, as in Postgres. */
function settings(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const m = /^([a-z_.]+)\s*=\s*(.+)$/.exec(line);
    if (m) out.set(m[1], m[2].trim().replace(/^'(.*)'$/, '$1'));
  }
  return out;
}

const conf = settings(read('infra/postgres/postgresql.conf'));

test('pg_stat_statements is preloaded and I/O time is tracked', () => {
  assert.equal(conf.get('shared_preload_libraries'), 'pg_stat_statements');
  assert.equal(conf.get('track_io_timing'), 'on');
});

test('planner settings suit SSDs and the plans stay cached', () => {
  assert.equal(conf.get('random_page_cost'), '1.1');
  assert.equal(conf.get('effective_io_concurrency'), '200');
  assert.equal(conf.get('jit'), 'off');
});

test('slow-statement logs carry no bind values', () => {
  assert.equal(conf.get('log_parameter_max_length'), '0');
  assert.ok(conf.has('log_min_duration_statement'), 'slow-statement logging is still on');
});

test('WAL is forced out at most every 5 minutes (OQ-R7-01 b)', () => {
  assert.equal(conf.get('archive_timeout'), '300');
  assert.equal(conf.get('archive_mode'), 'on');
});

test('init-dbs.sh creates the extension in the bos database for a new volume', () => {
  const script = read('infra/postgres/init-dbs.sh');
  const afterConnect = script.slice(script.indexOf('\\connect bos'));
  assert.match(afterConnect, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
});

test('app-up.sh creates it as the superuser on every deploy (the volume survives a redeploy)', () => {
  const script = read('infra/scripts/app-up.sh');
  const line = script
    .split(/\r?\n/)
    .find((l) => /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/.test(l));
  assert.ok(line, 'app-up.sh does not create the extension');
  assert.match(
    line,
    /psql -U postgres -d bos\b/,
    'must run as the postgres superuser in the bos database',
  );
});
