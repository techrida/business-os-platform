// No-browser selftests for partial/exploratory workflow planning and branches pure helpers.
// Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { planRuns } from '../lib/plan.mjs';
import { renderMarkdown, saveResults } from '../lib/runner.mjs';
import { hasEarlierRun, readFolderMeta } from '../lib/store.mjs';
import {
  branchesPaymentDecision,
  budgetCodeFor,
  extractPrUrls,
  hasAmount,
  parseNprAmount,
  pickCustomerOption,
  prPageCoversRun,
  workflow as branchesWorkflow,
} from '../workflows/branches.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'manual-run-branches-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const freshDir = () => mkdtempSync(path.join(tmp, 'd-'));

const SAMPLE_CFG = {
  appUrl: 'https://app.testrun.localhost:58343',
  runKey: 'r4-1440x0900',
  viewport: { width: 1440, height: 900 },
  navTimeout: 120000,
  actionTimeout: 45000,
};

describe('branches workflow shape', () => {
  const wf = branchesWorkflow(SAMPLE_CFG);

  test('lists all 12 guide steps in order with exactly 4, 5, 6, 7, 11, 12 scripted', () => {
    assert.equal(wf.name, 'branches');
    assert.deepEqual(wf.origins, ['app']);
    assert.deepEqual(
      wf.steps.map((s) => s.id),
      Array.from({ length: 12 }, (_, i) => `branches-${i + 1}`),
    );
    const scripted = wf.steps.filter((s) => !s.exploratory);
    const exploratory = wf.steps.filter((s) => s.exploratory);
    assert.deepEqual(
      scripted.map((s) => s.id),
      ['branches-4', 'branches-5', 'branches-6', 'branches-7', 'branches-11', 'branches-12'],
    );
    assert.deepEqual(
      exploratory.map((s) => s.id),
      ['branches-1', 'branches-2', 'branches-3', 'branches-8', 'branches-9', 'branches-10'],
    );
    for (const s of scripted) assert.equal(typeof s.run, 'function', `${s.id} has run()`);
    for (const s of exploratory) {
      assert.equal(s.run, undefined, `${s.id} has no run()`);
      assert.match(s.note, /exploratory agent pass/i);
    }
  });
});

describe('partial workflow planning and exploratory steps', () => {
  const wf = branchesWorkflow(SAMPLE_CFG);
  const PLAN_INPUT = [
    { name: 'start', stepIds: ['start-1', 'start-2'], exploratoryIds: [] },
    {
      name: 'branches',
      stepIds: wf.steps.filter((s) => !s.exploratory).map((s) => s.id),
      exploratoryIds: wf.steps.filter((s) => s.exploratory).map((s) => s.id),
    },
  ];

  test('a full run plans a partial workflow as full, and all-exploratory as not-implemented', () => {
    assert.deepEqual(
      planRuns(PLAN_INPUT, {}).map((p) => [p.name, p.mode]),
      [
        ['start', 'full'],
        ['branches', 'full'],
      ],
    );
    assert.deepEqual(planRuns([{ name: 'x', stepIds: [], exploratoryIds: ['x-1'] }], {}), [
      { name: 'x', mode: 'not-implemented' },
    ]);
  });

  test('--from and --only accept implemented steps and refuse exploratory steps clearly', () => {
    assert.deepEqual(planRuns(PLAN_INPUT, { from: 'branches-6' }), [
      { name: 'start', mode: 'skip', reason: 'listed before --from branches-6' },
      { name: 'branches', mode: 'from', from: 'branches-6' },
    ]);
    assert.deepEqual(planRuns(PLAN_INPUT, { only: 'branches-4,branches-12' }), [
      { name: 'start', mode: 'skip', reason: '--only lists none of its steps' },
      { name: 'branches', mode: 'only', only: ['branches-4', 'branches-12'] },
    ]);
    assert.throws(
      () => planRuns(PLAN_INPUT, { from: 'branches-1' }),
      /branches-1 is an exploratory step.*branches-4/,
    );
    assert.throws(
      () => planRuns(PLAN_INPUT, { only: 'branches-4,branches-9' }),
      /--only branches-9: exploratory step/,
    );
  });

  test('exploratory steps stay SKIPPED with their note across merges and keep a PASS', () => {
    const outDir = freshDir();
    const cfg = { outDir, label: 'r4', viewportText: '1440x900', appUrl: 'https://a.localhost' };
    const step = (id, status, note) => ({
      id,
      title: id,
      status,
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
      ...(note ? { note } : {}),
    });
    const first = {
      name: 'branches',
      title: 'Branches',
      runId: 'r1',
      status: 'PASS',
      wallMs: 10,
      videos: ['/v/branches.webm'],
      steps: [
        step('branches-1', 'SKIPPED', 'Exploratory step'),
        step('branches-4', 'PASS'),
        step('branches-5', 'SKIPPED'),
      ],
    };
    saveResults(cfg, first);
    const second = {
      name: 'branches',
      title: 'Branches',
      runId: 'r2',
      status: 'PASS',
      wallMs: 10,
      videos: ['/v/branches-from-branches-5.webm'],
      steps: [
        step('branches-1', 'SKIPPED', 'Exploratory step'),
        step('branches-4', 'SKIPPED'),
        step('branches-5', 'PASS'),
      ],
    };
    const merged = saveResults(cfg, second, first);
    assert.equal(merged.status, 'PASS');
    assert.deepEqual(
      merged.steps.map((s) => [s.id, s.status]),
      [
        ['branches-1', 'SKIPPED'],
        ['branches-4', 'PASS'],
        ['branches-5', 'PASS'],
      ],
    );
    const md = readFileSync(path.join(outDir, 'results.md'), 'utf8');
    assert.match(md, /\| branches-1 branches-1 \| SKIPPED \| 0 \| Exploratory step \|/);
    assert.match(
      renderMarkdown({
        label: 'x',
        viewport: '1440x900',
        appUrl: 'https://a',
        updatedAt: 't',
        workflows: { branches: merged },
      }),
      /SKIPPED 1, PASS 2/,
    );
  });

  test('a folder with only skipped exploratory steps does not count as an earlier run', () => {
    const outDir = freshDir();
    const cfg = { outDir, label: 'r4', viewportText: '1440x900', appUrl: 'https://a.localhost' };
    saveResults(cfg, {
      name: 'branches',
      title: 'Branches',
      runId: 'r1',
      status: 'SKIPPED',
      wallMs: 0,
      videos: [],
      steps: [
        {
          id: 'branches-1',
          title: 'b1',
          status: 'SKIPPED',
          note: 'Exploratory step',
          durationMs: 0,
          checks: [],
          findings: [],
          records: {},
        },
      ],
    });
    assert.equal(hasEarlierRun(outDir, 'branches'), false);
    assert.equal(readFolderMeta(outDir).hasRecords, false);
  });
});

describe('branches pure helpers', () => {
  test('hasAmount and parseNprAmount handle Nepali and Western grouping', () => {
    assert.equal(hasAmount('Total NPR 1,130.00', 1130), true);
    assert.equal(hasAmount('Total NPR 1,35,600.00', 135600), true);
    assert.equal(hasAmount('Total NPR 1,017.00', 1130), false);
    // An amount must stand alone: VAT 130.00 is not found inside a total of 1,130.00.
    assert.equal(hasAmount('Total NPR 1,130.00', 130), false);
    assert.equal(hasAmount('VAT NPR 130.00 · Total NPR 1,130.00', 130), true);
    assert.equal(hasAmount('NPR 10.00', 10), true);
    assert.equal(hasAmount('NPR 110.00 and 10.005', 10), false);
    assert.equal(parseNprAmount('Open amount\nNPR 1,017.00', 'Open amount'), 1017);
    assert.equal(parseNprAmount('Left on this payment NPR 10.00', 'Left on this payment'), 10);
    assert.equal(parseNprAmount('Customer advance NPR 20.00 unallocated in NPR'), 20);
    assert.equal(parseNprAmount('No balance shown', 'Open amount'), null);
  });

  test('budgetCodeFor keeps codes within the PR 64-character limit', () => {
    const maxRunKey = `${'a'.repeat(24)}-1440x0900`;
    assert.ok(budgetCodeFor('BOS-DEMO-CANCEL', maxRunKey).length <= 64);
    assert.ok(budgetCodeFor('BOS-DEMO-STALE', maxRunKey).length <= 64);
    assert.ok(budgetCodeFor('BOS-DEMO-EMERGENCY', maxRunKey).length <= 64);
    assert.throws(() => budgetCodeFor('X'.repeat(55), 'r4-1440x0900'), /max 64/);
  });

  test('pickCustomerOption prefers run customer, falls back to Dev Customer Co, and locks recorded name', () => {
    const company = 'BOS Demo Himalayan Labs SCR-r4-1440x0900';
    const opts = [
      'Choose a customer',
      'Dev Customer Co (CUST-DEV)',
      `${company} (CUS-2083/84-00001)`,
      `${company} Extra (CUS-2083/84-00002)`,
    ];
    assert.deepEqual(pickCustomerOption(opts, company), {
      ok: true,
      name: company,
      option: `${company} (CUS-2083/84-00001)`,
      source: 'run',
    });
    assert.deepEqual(
      pickCustomerOption(['Choose a customer', 'Dev Customer Co (CUST-DEV)'], company),
      {
        ok: true,
        name: 'Dev Customer Co',
        option: 'Dev Customer Co (CUST-DEV)',
        source: 'fallback',
      },
    );
    assert.deepEqual(pickCustomerOption(opts, company, 'Dev Customer Co'), {
      ok: true,
      name: 'Dev Customer Co',
      option: 'Dev Customer Co (CUST-DEV)',
      source: 'recorded',
    });
    assert.equal(pickCustomerOption(['Choose a customer'], company).ok, false);
    assert.equal(pickCustomerOption(opts, company, 'Missing Co').ok, false);
  });

  test('branchesPaymentDecision adopts exact ref, ignores other refs, and fails closed on ambiguity', () => {
    const ref = 'BOS-DEMO-ADVANCE-r4-1440x0900';
    assert.deepEqual(branchesPaymentDecision({ recordedUrl: '/payments/1', ref }), {
      action: 'reuse',
      url: '/payments/1',
    });
    assert.equal(branchesPaymentDecision({ lookup: { ok: false, rows: [] }, ref }).action, 'fail');
    // Unrelated payment on the same customer (e.g. another run or sales) does not block recording.
    assert.deepEqual(
      branchesPaymentDecision({
        lookup: { ok: true, rows: [{ url: '/payments/other', ref: 'BOS-DEMO-REJECT-old' }] },
        ref,
      }),
      { action: 'record' },
    );
    // Exact match is adopted; prefix/contained match is not.
    assert.deepEqual(
      branchesPaymentDecision({
        lookup: {
          ok: true,
          rows: [
            { url: '/payments/rej', ref: 'known' },
            { url: '/payments/other', ref: `${ref}0` },
            { url: '/payments/mine', ref: ` ${ref} ` },
          ],
        },
        ref,
        knownUrls: ['/payments/rej'],
      }),
      { action: 'adopt', url: '/payments/mine' },
    );
    assert.match(
      branchesPaymentDecision({
        lookup: {
          ok: true,
          rows: [
            { url: '/payments/a', ref },
            { url: '/payments/b', ref },
          ],
        },
        ref,
      }).reason,
      /2 payments carry/,
    );
    assert.match(
      branchesPaymentDecision({
        lookup: { ok: true, rows: [{ url: '/payments/a', ref: null }] },
        ref,
      }).reason,
      /could not be read/,
    );
    assert.match(
      branchesPaymentDecision({
        lookup: { ok: true, rows: [] },
        ref,
        knownUrls: ['/payments/rej'],
      }).reason,
      /may be incomplete/,
    );
  });

  test('prPageCoversRun accepts a cut-off page only when its last row is another run', () => {
    const marker = 'SCR-r4-1440x0900';
    assert.deepEqual(prPageCoversRun({ complete: { ok: true }, lastRowText: marker, marker }), {
      ok: true,
    });
    const cut = { ok: false, reason: 'the list has a next page' };
    // Close matches from other labels come after the exact hits: a last row of another run is fine.
    assert.equal(
      prPageCoversRun({ complete: cut, lastRowText: 'Demo cable. SCR-r4-0390x0844', marker }).ok,
      true,
    );
    assert.deepEqual(
      prPageCoversRun({ complete: cut, lastRowText: `Demo cable. ${marker} Draft`, marker }),
      { ok: false, reason: 'the list has a next page' },
    );
  });

  test("extractPrUrls keeps the rows carrying one of this run's exact justifications", () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const rows = [
      {
        text: 'Not numbered yet Disposable cancellation demonstration. SCR-r4-1440x0900 Cancelled',
        hrefs: [`/procurement/requests/${id1}`, `/procurement/requests/${id1}`],
      },
      {
        text: 'Not numbered yet Disposable cancellation demonstration. SCR-r4-0390x0844 Cancelled',
        hrefs: [`/procurement/requests/${id2}`],
      },
    ];
    assert.deepEqual(
      extractPrUrls(rows, 'Disposable cancellation demonstration. SCR-r4-1440x0900'),
      [`/procurement/requests/${id1}`],
    );
    // Several accepted texts (the stale-edit request may hold its first or its edited text).
    assert.deepEqual(
      extractPrUrls(
        [
          {
            text: 'Not numbered yet First tab saved. SCR-r4-0390x0844 Draft',
            hrefs: [`/procurement/requests/${id2}`],
          },
          ...rows,
        ],
        ['Initial text. SCR-r4-0390x0844', 'First tab saved. SCR-r4-0390x0844'],
      ),
      [`/procurement/requests/${id2}`],
    );
    assert.deepEqual(extractPrUrls(rows, ['Something else. SCR-r4-1440x0900']), []);
  });
});
