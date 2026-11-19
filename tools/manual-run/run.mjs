#!/usr/bin/env node
// Manual-run driver: performs the Business OS manual test guide through the real UI and records
// one video per workflow per viewport.
//
//   node tools/manual-run/run.mjs --workflow start|sales|procurement|branches|all \
//        --viewport 1440x900|390x844|820x1180|all --label scr1 [--from sales-7] [--only sales-3,sales-4]
//
// Environment: see README.md (APP_URL, PORTAL_URL, MAIL_URL, AUTH_URL, PERSONAS_FILE, CA_FILE,
// VIEWPORT, VIDEO_DIR, RUN_LABEL, SLOWMO, PACE, HEADLESS, CAPTIONS, DEMO_FILES, NETNS).
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { WORKFLOWS, loadConfig, parseArgs } from './lib/config.mjs';
import { planRuns } from './lib/plan.mjs';
import { runWorkflow, saveResults } from './lib/runner.mjs';
import { hasEarlierRun, readJson, resetWorkflow } from './lib/store.mjs';

const ALL_VIEWPORTS = ['1440x900', '820x1180', '390x844'];

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.workflow) {
  console.log(
    'usage: node tools/manual-run/run.mjs --workflow start|sales|procurement|branches|all ' +
      '--viewport 1440x900|820x1180|390x844|all --label scr1 [--from <step> | --only <step,step>] [--headed] [--no-captions]',
  );
  process.exit(args.help ? 0 : 2);
}

/** Everything wrong with the command line or environment stops here, before a browser starts. */
function usageError(message) {
  console.error(`manual-run: ${message}`);
  process.exit(2);
}

const workflowNames = args.workflow === 'all' ? WORKFLOWS : String(args.workflow).split(',');
for (const w of workflowNames) if (!WORKFLOWS.includes(w)) usageError(`unknown workflow ${w}`);
const vpArg = args.viewport ?? process.env.VIEWPORT ?? '1440x900';
const viewports = vpArg === 'all' ? ALL_VIEWPORTS : String(vpArg).split(',');
if (args['no-captions']) args.captions = 'false';

let configs;
try {
  configs = viewports.map((viewport) => loadConfig({ ...args, viewport }));
} catch (error) {
  usageError(error.message);
}

const modules = {};
for (const name of workflowNames) {
  modules[name] = await import(`./workflows/${name}.mjs`).catch((e) =>
    e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e),
  );
}
let plan;
try {
  plan = planRuns(
    workflowNames.map((name) => ({
      name,
      stepIds: modules[name] ? modules[name].workflow(configs[0]).steps.map((s) => s.id) : null,
    })),
    { from: args.from, only: args.only },
  );
} catch (error) {
  usageError(error.message);
}

// Never mix a new run into an earlier one silently: a full run of a workflow that already ran in
// this label's folder needs --fresh (or a new label); a partial run continues the earlier one.
if (args.fresh && (args.from || args.only))
  usageError('--fresh starts a workflow over; it cannot be combined with --from or --only.');
const conflicts = configs.flatMap((cfg) =>
  plan
    .filter((item) => item.mode === 'full' && hasEarlierRun(cfg.outDir, item.name))
    .map((item) => ({ cfg, name: item.name })),
);
if (conflicts.length && !args.fresh)
  usageError(
    `label ${configs[0].label} already ran ${conflicts.map((c) => `${c.name} in ${c.cfg.outDir}`).join(', ')}. ` +
      'Use a new label, resume with --from <step>, or pass --fresh to start over (its records keep ' +
      "the same unique names, so the earlier run's records can match them; a new label is safer).",
  );
for (const { cfg, name } of conflicts) {
  const backup = resetWorkflow(cfg.outDir, name);
  console.log(
    `[${cfg.viewportText} ${name}] --fresh: earlier records cleared` +
      (backup ? ` (copy in ${backup})` : ''),
  );
}
for (const cfg of configs)
  for (const item of plan)
    if ((item.mode === 'from' || item.mode === 'only') && !hasEarlierRun(cfg.outDir, item.name))
      console.warn(
        `[${cfg.viewportText} ${item.name}] note: no earlier run in ${cfg.outDir}; the steps run without its records`,
      );

const t0 = Date.now();
const summary = [];
for (const cfg of configs) {
  const viewport = cfg.viewportText;
  for (const item of plan) {
    const { name } = item;
    if (item.mode === 'skip') {
      // Not run in this invocation; its stored results stay untouched.
      summary.push({ viewport, name, status: 'NOT-RUN', wallMs: 0, videos: [] });
      console.log(`[${viewport} ${name}] not run (${item.reason})`);
      continue;
    }
    if (item.mode === 'not-implemented') {
      const skipped = {
        name,
        title: '(not implemented yet)',
        status: 'NOT-IMPLEMENTED',
        steps: [],
        videos: [],
        wallMs: 0,
      };
      saveResults(cfg, skipped);
      summary.push({ viewport, name, status: skipped.status, wallMs: 0, videos: [] });
      console.log(`[${viewport} ${name}] not implemented yet`);
      continue;
    }
    let r;
    try {
      r = await runWorkflow(cfg, modules[name].workflow(cfg), {
        from: item.from,
        only: item.only,
      });
    } catch (error) {
      // runWorkflow saves its own failures; this is the last resort, so one workflow's crash
      // never stops the others.
      console.error(`[${viewport} ${name}] driver error: ${error.message.split('\n')[0]}`);
      r = { status: 'FAIL', wallMs: 0, videos: [], steps: [] };
    }
    const counts = r.steps.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
    summary.push({ viewport, name, status: r.status, wallMs: r.wallMs, videos: r.videos, counts });
    console.log(
      `[${viewport} ${name}] ${r.status} in ${(r.wallMs / 1000).toFixed(0)} s ${JSON.stringify(counts)} → ${r.videos.join(', ')}`,
    );
  }
}

const label = configs[0].label;
const root = path.dirname(configs[0].outDir);
const lines = [
  `# Manual-run summary · label ${label}`,
  '',
  `Total wall time ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  '',
  '| viewport | workflow | status | s | steps | video |',
  '|---|---|---|---|---|---|',
];
for (const s of summary) {
  lines.push(
    `| ${s.viewport} | ${s.name} | ${s.status} | ${(s.wallMs / 1000).toFixed(0)} | ${JSON.stringify(s.counts ?? {})} | ${s.videos.join('<br>')} |`,
  );
}
const prev = readJson(path.join(root, 'summary.json'), []);
writeFileSync(
  path.join(root, 'summary.json'),
  JSON.stringify(
    [...prev, { at: new Date().toISOString(), wallMs: Date.now() - t0, runs: summary }],
    null,
    2,
  ),
);
writeFileSync(path.join(root, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(
  summary.every((s) => ['PASS', 'NOT-IMPLEMENTED', 'NOT-RUN'].includes(s.status)) ? 0 : 1,
);
