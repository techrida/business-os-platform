#!/usr/bin/env node
// Manual-run driver: performs the Business OS manual test guide through the real UI and records
// one video per workflow per viewport.
//
//   node tools/manual-run/run.mjs --workflow start|sales|procurement|branches|all \
//        --viewport 1440x900|390x844|820x1180|all --label SCR1 [--from sales-7] [--only sales-3,sales-4]
//
// Environment: see README.md (APP_URL, PORTAL_URL, MAIL_URL, PERSONAS_FILE, VIEWPORT, VIDEO_DIR,
// RUN_LABEL, SLOWMO, PACE, HEADLESS, CAPTIONS, DB_QUERY_CMD, DEMO_FILES).
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { WORKFLOWS, loadConfig, parseArgs } from './lib/config.mjs';
import { readJson, runWorkflow, saveResults } from './lib/runner.mjs';

const ALL_VIEWPORTS = ['1440x900', '820x1180', '390x844'];

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.workflow) {
  console.log(
    'usage: node tools/manual-run/run.mjs --workflow start|sales|procurement|branches|all ' +
      '--viewport 1440x900|820x1180|390x844|all --label SCR1 [--from <step>] [--only <step,step>] [--headed] [--no-captions]',
  );
  process.exit(args.help ? 0 : 2);
}

const workflowNames = args.workflow === 'all' ? WORKFLOWS : String(args.workflow).split(',');
for (const w of workflowNames) if (!WORKFLOWS.includes(w)) throw new Error(`Unknown workflow ${w}`);
const vpArg = args.viewport ?? process.env.VIEWPORT ?? '1440x900';
const viewports = vpArg === 'all' ? ALL_VIEWPORTS : String(vpArg).split(',');
if (args['no-captions']) args.captions = 'false';

const t0 = Date.now();
const summary = [];
for (const viewport of viewports) {
  const cfg = loadConfig({ ...args, viewport });
  for (const name of workflowNames) {
    const mod = await import(`./workflows/${name}.mjs`).catch((e) =>
      e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e),
    );
    if (!mod) {
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
    const r = await runWorkflow(cfg, mod.workflow(cfg), { from: args.from });
    const counts = r.steps.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
    summary.push({ viewport, name, status: r.status, wallMs: r.wallMs, videos: r.videos, counts });
    console.log(
      `[${viewport} ${name}] ${r.status} in ${(r.wallMs / 1000).toFixed(0)} s ${JSON.stringify(counts)} → ${r.videos.join(', ')}`,
    );
  }
}

const label = String(args.label ?? process.env.RUN_LABEL);
const root = path.dirname(loadConfig({ ...args, viewport: viewports[0] }).outDir);
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
process.exit(summary.every((s) => s.status === 'PASS' || s.status === 'NOT-IMPLEMENTED') ? 0 : 1);
