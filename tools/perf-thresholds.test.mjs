// Run: node --test tools/perf-thresholds.test.mjs
// The database-read gate (perf/k6/db-reads.js) is only a gate while every request it makes carries a tag that
// thresholds.js judges: a threshold on a tag nobody sends is an empty metric whose p(95) is 0 and passes forever.
// thresholds.js is k6 JavaScript and reads the global __ENV, so the test defines one before importing it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const READS = ['inbox_count', 'quotation_list', 'quotation_detail'];

async function load(env = {}) {
  globalThis.__ENV = env;
  const url = new URL('../perf/k6/thresholds.js', import.meta.url);
  return import(`${url.href}?${JSON.stringify(env)}`);
}

test('the db-reads gate judges the three reads against ADR 0011 (p95 300 ms, p99 800 ms)', async () => {
  const { buildDbReadsThresholds } = await load();
  assert.equal(typeof buildDbReadsThresholds, 'function');
  const t = buildDbReadsThresholds();
  for (const name of READS) {
    assert.deepEqual(t[`http_req_duration{name:${name}}`], ['p(95)<300', 'p(99)<800'], name);
    assert.deepEqual(t[`http_reqs{name:${name}}`], ['count>0'], `${name} must have samples`);
  }
  assert.ok(t.http_req_failed);
  assert.ok(t.checks);
});

test('K6_DB_READ_P95_MS tightens the limit, so the gate can be shown to fail', async () => {
  const { buildDbReadsThresholds } = await load({ K6_DB_READ_P95_MS: '1' });
  assert.equal(buildDbReadsThresholds()['http_req_duration{name:quotation_list}'][0], 'p(95)<1');
});

test('db-reads.js tags every read with a name thresholds.js judges, and prints p50 and p95 per read', () => {
  const script = readFileSync(new URL('../perf/k6/db-reads.js', import.meta.url), 'utf8');
  for (const name of READS) {
    assert.match(
      script,
      new RegExp(`get\\([^)]*, '${name}'\\)`),
      `${name} is tagged in db-reads.js`,
    );
  }
  assert.match(script, /buildDbReadsThresholds/);
  assert.match(script, /p\(50\)/);
  assert.match(script, /p\(95\)/);
});
