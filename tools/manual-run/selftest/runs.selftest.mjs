// --from/--only planning, no-overwrite names, per-workflow state, results history and the
// payment reuse decision. Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { planRuns } from '../lib/plan.mjs';
import { saveResults } from '../lib/runner.mjs';
import {
  hasEarlierRun,
  placeResult,
  readState,
  resetWorkflow,
  uniquePath,
  videoBase,
  writeState,
} from '../lib/store.mjs';
import { paymentDecision } from '../workflows/sales.mjs';

const WF = [
  { name: 'start', stepIds: ['start-1', 'start-2'] },
  { name: 'sales', stepIds: ['sales-1', 'sales-7', 'sales-8'] },
  { name: 'procurement', stepIds: null },
];

const tmp = mkdtempSync(path.join(tmpdir(), 'manual-run-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const freshDir = () => mkdtempSync(path.join(tmp, 'd-'));

describe('--from and --only planning', () => {
  test('a full run plans every workflow', () => {
    assert.deepEqual(
      planRuns(WF, {}).map((p) => p.mode),
      ['full', 'full', 'not-implemented'],
    );
  });

  test('--from applies only to the workflow that has the step', () => {
    const plan = planRuns(WF, { from: 'sales-7' });
    assert.deepEqual(
      plan.map((p) => [p.name, p.mode, p.from]),
      [
        ['start', 'skip', undefined],
        ['sales', 'from', 'sales-7'],
        ['procurement', 'not-implemented', undefined],
      ],
    );
  });

  test('an unknown --from step is refused before anything runs, naming the steps', () => {
    assert.throws(() => planRuns(WF, { from: 'sales-99' }), /sales-99.*sales-1, sales-7/);
    assert.throws(() => planRuns([WF[0]], { from: 'sales-7' }), /not a step/);
    assert.throws(() => planRuns(WF, { from: true }), /needs a step id/);
  });

  test('--only runs just the workflows that hold those steps', () => {
    const plan = planRuns(WF, { only: 'sales-8, start-2' });
    assert.deepEqual(
      plan.map((p) => [p.name, p.mode, p.only]),
      [
        ['start', 'only', ['start-2']],
        ['sales', 'only', ['sales-8']],
        ['procurement', 'skip', undefined],
      ],
    );
    assert.throws(() => planRuns(WF, { only: 'sales-8,nope' }), /--only nope/);
    assert.throws(() => planRuns(WF, { only: ',' }), /at least one/);
    assert.throws(() => planRuns(WF, { from: 'sales-7', only: 'sales-8' }), /either/);
  });
});

describe('no overwrites', () => {
  test('uniquePath counts up instead of replacing a file', () => {
    const dir = mkdtempSync(path.join(tmp, 'u-'));
    const first = uniquePath(dir, 'sales', '.webm');
    assert.equal(path.basename(first), 'sales.webm');
    writeFileSync(first, 'x');
    assert.equal(path.basename(uniquePath(dir, 'sales', '.webm')), 'sales-2.webm');
    writeFileSync(path.join(dir, 'sales-2.webm'), 'x');
    assert.equal(path.basename(uniquePath(dir, 'sales', '.webm')), 'sales-3.webm');
  });

  test('every kind of run has its own video name stem', () => {
    assert.equal(videoBase('sales'), 'sales');
    assert.equal(videoBase('sales', { from: 'sales-7' }), 'sales-from-sales-7');
    assert.equal(
      videoBase('sales', { only: ['sales-3', 'sales-4'] }),
      'sales-only-sales-3_sales-4',
    );
  });

  test('a new run keeps the earlier result under history; saves of one run do not', () => {
    const all = { workflows: {} };
    placeResult(all, 'sales', { runId: 'a', status: 'RUNNING' });
    placeResult(all, 'sales', { runId: 'a', status: 'PASS' });
    assert.equal(all.history, undefined);
    placeResult(all, 'sales', { runId: 'b', status: 'FAIL' });
    assert.deepEqual(all.history.sales, [{ runId: 'a', status: 'PASS' }]);
    assert.equal(all.workflows.sales.runId, 'b');
    // A NOT-IMPLEMENTED placeholder carries nothing worth keeping.
    placeResult(all, 'branches', { status: 'NOT-IMPLEMENTED' });
    placeResult(all, 'branches', { status: 'NOT-IMPLEMENTED' });
    assert.equal(all.history.branches, undefined);
  });

  test('saveResults through results.json: an --only run never erases the full run', () => {
    const outDir = freshDir();
    const cfg = { outDir, label: 'scr1', viewportText: '1440x900', appUrl: 'https://a.localhost' };
    const step = (id, status) => ({
      id,
      title: id,
      status,
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
    });
    const full = {
      name: 'sales',
      title: 't',
      runId: 'r1',
      status: 'PASS',
      wallMs: 1,
      videos: ['/v/sales.webm'],
      steps: [step('sales-1', 'PASS'), step('sales-3', 'PASS')],
    };
    saveResults(cfg, full);
    const partial = {
      name: 'sales',
      title: 't',
      runId: 'r2',
      status: 'PASS',
      wallMs: 1,
      videos: ['/v/sales-only-sales-3.webm'],
      steps: [step('sales-1', 'SKIPPED'), step('sales-3', 'PASS')],
    };
    const merged = saveResults(cfg, partial, full);
    assert.equal(merged.steps[0].status, 'PASS');
    assert.equal(merged.steps[0].fromEarlierRun, true);
    assert.deepEqual(merged.videos, ['/v/sales.webm', '/v/sales-only-sales-3.webm']);
    const saved = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    assert.equal(saved.history.sales[0].runId, 'r1');
    assert.ok(existsSync(path.join(outDir, 'results.md')));
  });
});

describe('per-workflow state', () => {
  test('workflows keep separate records; a legacy flat file is read for every workflow', () => {
    const dir = freshDir();
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ memoUrl: '/memos/1', leadUrl: '/leads/1' }));
    assert.equal(readState(file, 'sales').leadUrl, '/leads/1');
    writeState(file, 'sales', { leadUrl: '/leads/2' });
    assert.equal(readState(file, 'sales').leadUrl, '/leads/2');
    assert.equal(readState(file, 'start').memoUrl, '/memos/1');
  });

  test('an earlier run is detected per workflow, and --fresh clears only that workflow', () => {
    const dir = freshDir();
    assert.equal(hasEarlierRun(dir, 'sales'), false);
    writeState(path.join(dir, 'state.json'), 'start', { memoUrl: '/memos/1' });
    assert.equal(hasEarlierRun(dir, 'start'), true);
    assert.equal(hasEarlierRun(dir, 'sales'), false, 'start ran, sales did not');
    writeState(path.join(dir, 'state.json'), 'sales', { leadUrl: '/leads/1' });
    const backup = resetWorkflow(dir, 'sales');
    assert.ok(backup && existsSync(backup));
    assert.deepEqual(readState(path.join(dir, 'state.json'), 'sales'), {});
    assert.equal(readState(path.join(dir, 'state.json'), 'start').memoUrl, '/memos/1');
  });
});

describe('payments are recorded at most once per run', () => {
  test('a recorded URL is reused', () => {
    assert.deepEqual(
      paymentDecision({ recordedUrl: '/payments/a', rowUrls: ['/payments/b'], knownUrls: [] }),
      { action: 'reuse', url: '/payments/a' },
    );
  });
  test('a payment of this customer that is not a known one is adopted, not duplicated', () => {
    assert.deepEqual(
      paymentDecision({
        recordedUrl: null,
        rowUrls: ['/payments/one', '/payments/two', '/payments/two'],
        knownUrls: ['/payments/one'],
      }),
      { action: 'adopt', urls: ['/payments/two'] },
    );
  });
  test('a new payment only when the customer has none besides the known ones', () => {
    assert.deepEqual(
      paymentDecision({
        recordedUrl: null,
        rowUrls: ['/payments/one'],
        knownUrls: ['/payments/one'],
      }),
      { action: 'record' },
    );
    assert.deepEqual(paymentDecision({ recordedUrl: undefined, rowUrls: [], knownUrls: [] }), {
      action: 'record',
    });
  });
});
