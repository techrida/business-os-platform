import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { summarize, percentile } from './flow-summary.mjs';
import { parseTimings, parseApiLog } from './flow-backend.mjs';

const limits = {
  'approve-step-1': { page: 500, backend: 80 },
  'submit-memo': { page: 500, backend: 80 },
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
    /\| approve-step-1 \| 20 \| 1 \| 300 \| 570 \| 600 \| 500 \| over \| 19 \| 1 \| 50 \| 95 \| 95 \| 80 \| over \|/,
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
      /\| issue-invoice \| 1 \| 0 \| 700 \| 700 \| 700 \| 500 \| over \| 1 \| 0 \| 100 \| 100 \| 100 \| 80 \| over \|/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
