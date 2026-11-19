// --from/--only planning, no-overwrite names, per-workflow state, results history and the
// payment reuse decision. Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { planRuns } from '../lib/plan.mjs';
import { clearSecrets, registerSecret } from '../lib/redact.mjs';
import { saveDriverError, saveResults } from '../lib/runner.mjs';
import {
  acquireLock,
  claimPath,
  hasEarlierRun,
  placeResult,
  readFolderMeta,
  readState,
  resetWorkflow,
  uniquePath,
  videoBase,
  writeJson,
  writeState,
} from '../lib/store.mjs';
import { uniqueValues } from '../lib/config.mjs';
import { contactEmailFor, paymentDecision } from '../workflows/sales.mjs';

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

  test('a run that could not start does not count as an earlier run', () => {
    const dir = freshDir();
    const cfg = {
      outDir: dir,
      label: 'x',
      viewportText: '1440x900',
      appUrl: 'https://a.localhost',
    };
    saveResults(cfg, {
      name: 'sales',
      title: 't',
      runId: 'r1',
      status: 'FAIL',
      error: 'Could not start: TLS',
      steps: [],
      videos: [],
      wallMs: 0,
    });
    assert.equal(hasEarlierRun(dir, 'sales'), false);
    const step = {
      id: 'sales-1',
      title: 's',
      status: 'FAIL',
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
    };
    saveResults(cfg, {
      name: 'sales',
      title: 't',
      runId: 'r2',
      status: 'FAIL',
      steps: [step],
      videos: [],
      wallMs: 0,
    });
    assert.equal(hasEarlierRun(dir, 'sales'), true);
  });
});

describe('payments are recorded at most once per run', () => {
  const ref = 'BOS-DEMO-PAY-01-x-1440x0900';
  const ok = (rows) => ({ ok: true, rows });
  test('a recorded URL is reused without a lookup', () => {
    assert.deepEqual(paymentDecision({ recordedUrl: '/payments/a', ref, knownUrls: [] }), {
      action: 'reuse',
      url: '/payments/a',
    });
  });
  test('a failed lookup never counts as "no payment"', () => {
    for (const lookup of [null, undefined, { ok: false, rows: [] }])
      assert.equal(paymentDecision({ lookup, ref, knownUrls: [] }).action, 'fail');
  });
  test('the one payment with exactly this bank reference is adopted', () => {
    assert.deepEqual(
      paymentDecision({
        lookup: ok([
          { url: '/payments/one', ref: 'known' },
          { url: '/payments/two', ref: ` ${ref} ` },
        ]),
        ref,
        knownUrls: ['/payments/one'],
      }),
      { action: 'adopt', url: '/payments/two' },
    );
  });
  test('two payments with this reference fail loudly (possible duplicate)', () => {
    const d = paymentDecision({
      lookup: ok([
        { url: '/payments/a', ref },
        { url: '/payments/b', ref },
      ]),
      ref,
      knownUrls: [],
    });
    assert.equal(d.action, 'fail');
    assert.match(d.reason, /2 payments carry the bank reference/);
  });
  test('a reference that only contains this one is not a match, and stops the step', () => {
    const d = paymentDecision({
      lookup: ok([{ url: '/payments/a', ref: `${ref}0` }]),
      ref,
      knownUrls: [],
    });
    assert.equal(d.action, 'fail');
    assert.match(d.reason, /another bank reference/);
  });
  test('an unreadable reference or a missing known payment fails', () => {
    assert.match(
      paymentDecision({ lookup: ok([{ url: '/payments/a', ref: null }]), ref, knownUrls: [] })
        .reason,
      /could not be read/,
    );
    assert.match(
      paymentDecision({ lookup: ok([]), ref, knownUrls: ['/payments/one'] }).reason,
      /may be incomplete/,
    );
  });
  test('a new payment only after a lookup that loaded and shows none', () => {
    assert.deepEqual(
      paymentDecision({
        lookup: ok([{ url: '/payments/one', ref: 'known' }]),
        ref,
        knownUrls: ['/payments/one'],
      }),
      { action: 'record' },
    );
    assert.deepEqual(paymentDecision({ lookup: ok([]), ref, knownUrls: [] }), {
      action: 'record',
    });
  });
});

describe('results are saved redacted, and a driver error keeps the saved steps', () => {
  const cfg = (outDir) => ({
    outDir,
    label: 'x',
    viewportText: '1440x900',
    appUrl: 'https://a.localhost',
  });
  const step = (id, extra = {}) => ({
    id,
    title: id,
    status: 'PASS',
    durationMs: 123456,
    checks: [],
    findings: [],
    records: {},
    ...extra,
  });
  after(clearSecrets);

  test('a secret in an error, a check or a finding never reaches results.json or results.md', () => {
    const dir = freshDir();
    registerSecret('Pa55-w0rd"x');
    saveResults(cfg(dir), {
      name: 'start',
      title: 't',
      runId: 'r1',
      status: 'FAIL',
      wallMs: 123456,
      videos: [],
      steps: [
        step('start-6', {
          status: 'FAIL',
          error: 'locator.fill: Timeout | - fill("Pa55-w0rd\\"x")',
          checks: ['typed Pa55-w0rd"x'],
          findings: [{ severity: 'normal', text: 'saw Pa55-w0rd"x' }],
        }),
      ],
    });
    for (const f of ['results.json', 'results.md']) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!text.includes('Pa55-w0rd'), `${f} holds the password`);
      assert.ok(text.includes('[redacted]'), f);
    }
    const saved = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(saved.workflows.start.steps[0].durationMs, 123456, 'numbers stay numbers');
  });

  test('saveDriverError marks this run FAIL and keeps its steps', () => {
    const dir = freshDir();
    const since = new Date(Date.now() - 1000).toISOString();
    saveResults(cfg(dir), {
      name: 'sales',
      title: 't',
      runId: `${new Date().toISOString()}-${process.pid}`,
      startedAt: new Date().toISOString(),
      status: 'RUNNING',
      wallMs: 1,
      videos: [],
      steps: [step('sales-1'), step('sales-2')],
    });
    const r = saveDriverError(cfg(dir), 'sales', 'Driver error: boom', since);
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error, 'Driver error: boom');
    assert.deepEqual(
      r.steps.map((st) => st.id),
      ['sales-1', 'sales-2'],
    );
    // Without a result of this run, a FAIL without steps is written.
    const other = freshDir();
    assert.deepEqual(saveDriverError(cfg(other), 'sales', 'Driver error: x', since).steps, []);
  });
});

describe('the customer e-mail on a resumed run', () => {
  const u = uniqueValues('fix1-1440');
  const v = {
    email: `${u.emailLocal}@bos-demo.example.com`,
    legacyEmail: `${u.legacyEmailLocal}@bos-demo.example.com`,
  };
  test('a new run uses the current address', () => {
    assert.equal(contactEmailFor({}, v), 'anu.mr-fix1-1440@bos-demo.example.com');
  });
  test('the recorded address wins', () => {
    assert.equal(
      contactEmailFor({ contactEmail: 'a@b.example', opportunityUrl: '/o/1' }, v),
      'a@b.example',
    );
  });
  test('a folder whose customer was created before the address was recorded uses the old form', () => {
    assert.equal(
      contactEmailFor({ opportunityUrl: '/opportunities/1' }, v),
      'anu.scr-fix1-1440@bos-demo.example.com',
    );
  });
});
