// Runs one workflow's steps in order in one recorded browser context and writes the results.
// A failed step gets a screenshot; the steps after it are BLOCKED; the next workflow still runs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launch, newRecordedContext } from './browser.mjs';
import { Session, StepFailure } from './session.mjs';

const now = () => new Date().toISOString();

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function origins(cfg) {
  const auth = process.env.AUTH_URL || cfg.appUrl.replace('://app.', '://auth.');
  return [cfg.appUrl, cfg.portalUrl, cfg.mailUrl, auth];
}

/**
 * @param {object} workflow { name, title, steps: [{ id, title, run(session) }] }
 * @param {object} opts { from?: step id to resume at (earlier steps are SKIPPED, state is reloaded) }
 */
export async function runWorkflow(cfg, workflow, opts = {}) {
  mkdirSync(cfg.outDir, { recursive: true });
  const shotsDir = path.join(cfg.outDir, 'shots');
  const filesDir = path.join(cfg.outDir, 'downloads');
  const videoTmp = path.join(cfg.outDir, '.video-tmp');
  for (const d of [shotsDir, filesDir, videoTmp]) mkdirSync(d, { recursive: true });

  const stateFile = path.join(cfg.outDir, 'state.json');
  const state = readJson(stateFile, {});
  state.label = cfg.label;
  const log = (line) => console.log(`[${cfg.viewportText} ${workflow.name}] ${line}`);
  const result = {
    name: workflow.name,
    title: workflow.title,
    status: 'PASS',
    startedAt: now(),
    steps: [],
    videos: [],
  };
  const t0 = Date.now();

  const browser = await launch(cfg, origins(cfg));
  const context = await newRecordedContext(browser, cfg, videoTmp);
  const session = await Session.open({ context, cfg, state, log });
  session.dirs = { shots: shotsDir, files: filesDir, video: videoTmp };
  session.browser = browser;

  let blocked = null;
  const fromIndex = opts.from ? workflow.steps.findIndex((s) => s.id === opts.from) : 0;
  if (fromIndex < 0) throw new Error(`--from ${opts.from}: no such step in ${workflow.name}`);
  for (const [index, step] of workflow.steps.entries()) {
    const skipping = index < fromIndex || (cfg.only && !cfg.only.includes(step.id));
    const entry = {
      id: step.id,
      title: step.title,
      status: 'PASS',
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
    };
    result.steps.push(entry);
    if (skipping) {
      entry.status = 'SKIPPED';
      continue;
    }
    if (blocked) {
      entry.status = 'BLOCKED';
      entry.error = `Not run: ${blocked} failed`;
      continue;
    }
    const before = { ...state };
    session.checks = [];
    session.findings = [];
    session.consoleErrors = [];
    const s0 = Date.now();
    log(`${step.id} — ${step.title}`);
    try {
      await session.caption(`${step.id} — ${step.title}`);
      const limit = step.timeoutMs ?? cfg.stepTimeout;
      await withTimeout(
        step.run(session),
        limit,
        `${step.id} did not finish within ${limit / 1000} s`,
      );
      await session.pause();
    } catch (error) {
      entry.status = 'FAIL';
      entry.error =
        (error instanceof StepFailure ? '' : 'Error: ') +
        error.message.split('\n').slice(0, 6).join(' | ');
      entry.url = session.page.url();
      const shot = path.join(shotsDir, `${step.id}-FAIL.png`);
      await session.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      entry.screenshot = shot;
      log(`FAIL ${step.id}: ${entry.error}`);
      await session.caption(`${step.id} FAILED — ${entry.error.slice(0, 160)}`);
      await session.pause(2500);
      blocked = step.id;
      result.status = 'FAIL';
    }
    entry.durationMs = Date.now() - s0;
    entry.checks = session.checks;
    entry.findings = session.findings;
    if (session.consoleErrors.length) entry.consoleErrors = session.consoleErrors.slice(0, 12);
    for (const [k, v] of Object.entries(state))
      if (JSON.stringify(before[k]) !== JSON.stringify(v)) entry.records[k] = v;
    writeJson(stateFile, state);
    log(`${entry.status} ${step.id} (${(entry.durationMs / 1000).toFixed(1)} s)`);
  }

  // Videos are written when their page's context closes.
  const pages = context.pages();
  const extra = session.extraContexts ?? [];
  await context.close().catch(() => {});
  for (const c of extra) await c.context.close().catch(() => {});
  await browser.close().catch(() => {});
  let n = 0;
  for (const p of pages) {
    const v = await p
      .video()
      ?.path()
      .catch(() => null);
    if (v && existsSync(v)) {
      const name = n === 0 ? `${workflow.name}.webm` : `${workflow.name}-page${n + 1}.webm`;
      const dest = path.join(cfg.outDir, name);
      renameSync(v, dest);
      result.videos.push(dest);
      n++;
    }
  }
  for (const c of extra) {
    for (const p of c.pages) {
      const v = await p
        .video()
        ?.path()
        .catch(() => null);
      if (v && existsSync(v)) {
        const dest = path.join(cfg.outDir, `${workflow.name}-${c.name}.webm`);
        renameSync(v, dest);
        result.videos.push(dest);
      }
    }
  }
  result.video = result.videos[0] ?? null;
  result.finishedAt = now();
  result.wallMs = Date.now() - t0;
  if (result.steps.every((s) => s.status === 'SKIPPED')) result.status = 'SKIPPED';
  saveResults(cfg, result);
  return result;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepFailure(message)), ms);
    }),
  ]);
}

export function saveResults(cfg, workflowResult) {
  const file = path.join(cfg.outDir, 'results.json');
  const all = readJson(file, {
    label: cfg.label,
    viewport: cfg.viewportText,
    appUrl: cfg.appUrl,
    workflows: {},
  });
  all.workflows[workflowResult.name] = workflowResult;
  all.updatedAt = now();
  writeJson(file, all);
  writeFileSync(path.join(cfg.outDir, 'results.md'), renderMarkdown(all));
}

export function renderMarkdown(all) {
  const lines = [
    `# Manual-run results · label ${all.label} · viewport ${all.viewport}`,
    '',
    `App: ${all.appUrl} · updated ${all.updatedAt}`,
    '',
  ];
  for (const wf of Object.values(all.workflows)) {
    const counts = {};
    for (const s of wf.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
    lines.push(`## ${wf.name} · ${wf.title} · ${wf.status}`, '');
    lines.push(
      `Wall time ${(wf.wallMs / 1000).toFixed(0)} s · ${Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
    for (const v of wf.videos) lines.push(`- video: ${v}`);
    lines.push('', '| step | status | s | notes |', '|---|---|---|---|');
    for (const s of wf.steps) {
      const notes = [
        s.error,
        ...s.findings.map((f) => `FINDING (${f.severity}): ${f.text}`),
        s.screenshot && `shot: ${s.screenshot}`,
      ]
        .filter(Boolean)
        .join('<br>')
        .replace(/\|/g, '/');
      lines.push(
        `| ${s.id} ${s.title} | ${s.status} | ${(s.durationMs / 1000).toFixed(0)} | ${notes} |`,
      );
    }
    const records = Object.assign({}, ...wf.steps.map((s) => s.records));
    if (Object.keys(records).length) {
      lines.push('', 'Records created:', '');
      for (const [k, v] of Object.entries(records))
        lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
