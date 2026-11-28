import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { summarize, percentile } from './flow-summary.mjs';
import { parseTimings, parseApiLog } from './flow-backend.mjs';

const limits = {
  'approve-step-1': { page: { good: 400, poor: 500 }, backend: { good: 50, poor: 80 } },
  'submit-memo': { page: { good: 400, poor: 500 }, backend: { good: 50, poor: 80 } },
};

test('nearest rank reports p50/p95/p99 with sample size, misses and breaches', () => {
  assert.equal(percentile([], 95), undefined);
  assert.equal(percentile([100, 1, 2, 3], 50), 2);
  const rows = Array.from({ length: 20 }, (_, i) => ({
    name: 'approve-step-1',
    pageMs: (i + 1) * 30,
    ok: true,
    requestIds: [`id-${i}`],
  }));
  rows.push({ name: 'approve-step-1', pageMs: 9999, ok: false, requestIds: [] });
  const logs = rows
    .slice(0, 19)
    .map((row, i) =>
      JSON.stringify({
        msg: 'request completed',
        req: { id: row.requestIds[0], method: 'POST', url: '/v1/approvals/requests/a/actions' },
        responseTime: (i + 1) * 5,
      }),
    )
    .join('\n');
  const result = summarize(rows, parseApiLog(logs), limits);
  assert.match(
    result,
    /\| approve-step-1 \| 20 \| 1 \| 300 \| 570 \| 600 \| 400 \/ 500 \| poor \| 19 \| 1 \| 50 \| 95 \| 95 \| 50 \/ 80 \| poor \|/,
  );
  assert.match(result, /\| submit-memo \| 0 \| 0 \| n\/a/);
});

test('timing parser skips malformed records and preserves failed samples', () => {
  const row = { name: 'submit-memo', pageMs: 37, ok: false, requestIds: ['id'] };
  assert.deepEqual(
    parseTimings(
      `${JSON.stringify(row)}\n{bad\n{"name":"bad","pageMs":-3,"ok":true,"requestIds":[]}`,
    ),
    [row],
  );
});

test('CLI reads the paired files and still exits successfully when the limits are exceeded', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-summary-'));
  try {
    const timing = path.join(dir, 'timing.jsonl');
    const log = path.join(dir, 'api.log');
    writeFileSync(
      timing,
      JSON.stringify({ name: 'issue-invoice', pageMs: 700, ok: true, requestIds: ['req-1'] }),
    );
    writeFileSync(
      log,
      JSON.stringify({
        msg: 'request completed',
        req: { id: 'req-1', method: 'POST', url: '/v1/invoices/a/issue' },
        responseTime: 100,
      }),
    );
    const script = (name) => fileURLToPath(new URL(name, import.meta.url));
    const config = path.join(dir, 'limits.json');
    writeFileSync(config, JSON.stringify({
      'issue-invoice': { source: 'browser', page: {good: 400, poor: 1000}, backend: {good: 50, poor: 80} },
      unmeasured: {source: 'k6'},
    }));
    const args = [timing, log];
    const backend = execFileSync(process.execPath, [script('./flow-backend.mjs'), ...args], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(backend).backendMs, 100);
    const summary = execFileSync(process.execPath, [script('./flow-summary.mjs'), ...args], {
      encoding: 'utf8',
    });
    assert.match(
      summary,
      /\| issue-invoice \| 1 \| 0 \| 700 \| 700 \| 700 \| 400 \/ 1000 \| ok \| 1 \| 0 \| 100 \| 100 \| 100 \| 50 \/ 80 \| poor \|/,
    );
    const gate = () =>
      spawnSync(process.execPath, [script('./flow-summary.mjs'), '--gate', ...args, config], {
        encoding: 'utf8',
      });
    assert.equal(gate().status, 1);
    writeFileSync(timing, '');
    writeFileSync(log, '');
    assert.equal(gate().status, 1);
    writeFileSync(timing, JSON.stringify({name: 'issue-invoice', pageMs: 10, ok: true, requestIds: ['missing']}));
    assert.equal(gate().status, 1);
    for (const [pageMs, backendMs, expected, grade] of [
      [400, 50, 0, 'good'],
      [1000, 80, 0, 'ok'],
      [1000.01, 50, 1, 'poor'],
    ]) {
      writeFileSync(
        timing,
        JSON.stringify({ name: 'issue-invoice', pageMs, ok: true, requestIds: ['r'] }),
      );
      writeFileSync(
        log,
        JSON.stringify({
          msg: 'request completed',
          req: { id: 'r', method: 'POST', url: '/v1/invoices/a/issue' },
          responseTime: backendMs,
        }),
      );
      const result = gate();
      assert.equal(result.status, expected);
      assert.ok(result.stdout.includes(`400 / 1000 | ${grade} |`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('k6 flow tags have the configured backend fail lines', async () => {
  globalThis.__ENV = {};
  try {
    const { FLOW_THRESHOLDS } = await import('../../perf/k6/thresholds.js');
    const { readFileSync } = await import('node:fs');
    const flows = JSON.parse(readFileSync(new URL('./flow-limits.json', import.meta.url)));
    for (const [flow, limits] of Object.entries(flows)) {
      assert.deepEqual(FLOW_THRESHOLDS[`http_req_duration{flow:${flow}}`], [
        `p(95)<${limits.backend.poor}`,
      ]);
    }
  } finally {
    delete globalThis.__ENV;
  }
});
