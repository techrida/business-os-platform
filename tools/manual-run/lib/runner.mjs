// Runs one workflow's steps in order in one recorded browser context and writes the results.
// A failed step gets a screenshot; the steps after it are BLOCKED; the next workflow still runs.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launch, newRecordedContext } from './browser.mjs';
import { redactText, redactUrl } from './redact.mjs';
import { Session, StepFailure } from './session.mjs';
import {
  placeResult,
  readJson,
  readState,
  uniquePath,
  videoBase,
  writeJson,
  writeState,
} from './store.mjs';

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function origins(cfg) {
  return [cfg.appUrl, cfg.portalUrl, cfg.mailUrl, cfg.authUrl];
}

const ORIGIN_KEYS = { app: 'appUrl', portal: 'portalUrl', mail: 'mailUrl', auth: 'authUrl' };

/** The origins a workflow declares (`origins: ['app', 'mail']`); all of them when it declares none. */
export function workflowOrigins(cfg, workflow) {
  if (!workflow.origins) return origins(cfg);
  return workflow.origins.map((k) => {
    if (!ORIGIN_KEYS[k]) throw new Error(`${workflow.name}: unknown origin "${k}"`);
    return cfg[ORIGIN_KEYS[k]];
  });
}

/**
 * Runs one workflow and always returns its saved result: a failure before the first step (TLS
 * check, browser launch, session setup) is saved as a FAIL with that error, and the browser, its
 * contexts and the network forwarders are closed in every case.
 * @param {object} workflow { name, title, origins?, steps: [{ id, title, run(session) }] }
 * @param {object} opts { from?: resume at this step; only?: step ids to run (others SKIPPED) }
 */
export async function runWorkflow(cfg, workflow, opts = {}) {
  mkdirSync(cfg.outDir, { recursive: true });
  const shotsDir = path.join(cfg.outDir, 'shots');
  const filesDir = path.join(cfg.outDir, 'downloads');
  const videoTmp = path.join(cfg.outDir, '.video-tmp');
  for (const d of [shotsDir, filesDir, videoTmp]) mkdirSync(d, { recursive: true });

  const stateFile = path.join(cfg.outDir, 'state.json');
  // A partial run (--from, --only) continues with the records of the earlier run; a full run
  // starts empty (run.mjs refuses a full run over an earlier one unless --fresh).
  const partial = Boolean(opts.from || opts.only);
  const state = partial ? readState(stateFile, workflow.name) : {};
  const log = (line) => console.log(`[${cfg.viewportText} ${workflow.name}] ${redactText(line)}`);
  const startedAt = now();
  const result = {
    name: workflow.name,
    title: workflow.title,
    // Saves of the same run replace each other; a different run's entry moves to history.
    runId: `${startedAt}-${process.pid}`,
    mode: opts.from ? 'from' : opts.only ? 'only' : 'full',
    status: 'PASS',
    startedAt,
    steps: [],
    videos: [],
    resumedFrom: opts.from ?? null,
    only: opts.only ?? null,
  };
  const t0 = Date.now();
  // The earlier run's result, read once: a partial run is merged with it on every save, and the
  // earlier entry itself is kept under history.
  const earlier = partial
    ? (readJson(path.join(cfg.outDir, 'results.json'), {}).workflows?.[workflow.name] ?? null)
    : null;
  // Every run records its own video segment; an existing file is never replaced.
  const base = videoBase(workflow.name, opts);
  // Checked by run.mjs before any launch; repeated here for direct callers.
  const fromIndex = opts.from ? workflow.steps.findIndex((s) => s.id === opts.from) : 0;
  if (fromIndex < 0) throw new Error(`--from ${opts.from}: no such step in ${workflow.name}`);

  let browser = null;
  let context = null;
  let session = null;
  try {
    browser = await launch(cfg, workflowOrigins(cfg, workflow), origins(cfg));
    context = await newRecordedContext(browser, cfg, videoTmp);
    session = await Session.open({ context, cfg, state, log });
    session.dirs = { shots: shotsDir, files: filesDir, video: videoTmp };
    session.browser = browser;
  } catch (error) {
    // Nothing ran: record why, so the summary and results.json show it instead of a crash.
    result.status = 'FAIL';
    result.error = redactText(`Could not start: ${error.message.split('\n')[0]}`);
    log(result.error);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    result.finishedAt = now();
    result.wallMs = Date.now() - t0;
    return saveResults(cfg, result, earlier);
  }

  try {
    let blocked = null;
    for (const [index, step] of workflow.steps.entries()) {
      // Saved before every step, so a run that is killed keeps the results of the steps it finished.
      saveResults(cfg, { ...result, status: 'RUNNING', wallMs: Date.now() - t0 }, earlier);
      const skipping = index < fromIndex || (opts.only && !opts.only.includes(step.id));
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
        const message = `${step.id} did not finish within ${limit / 1000} s`;
        const body = step.run(session);
        await withTimeout(body, limit, message, async () => {
          // Cancel the step, then give its current action a moment to fail before the screenshot.
          await session.abort(message);
          await Promise.race([body.catch(() => {}), sleep(10000)]);
        });
        await session.pause();
      } catch (thrown) {
        // After a timeout the body's own error (an aborted request) is a consequence, not the cause.
        const error = session.abortReason ? new StepFailure(session.abortReason) : thrown;
        entry.status = 'FAIL';
        entry.error = redactText(
          (error instanceof StepFailure ? '' : 'Error: ') +
            error.message.split('\n').slice(0, 6).join(' | '),
        );
        entry.url = redactUrl(session.page.url());
        const shot = uniquePath(shotsDir, `${step.id}-FAIL`, '.png');
        await session.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        entry.screenshot = shot;
        log(`FAIL ${step.id}: ${entry.error}`);
        await session.caption(`${step.id} FAILED — ${entry.error.slice(0, 160)}`);
        await session.pause(2500);
        blocked = step.id;
        result.status = 'FAIL';
      }
      entry.durationMs = Date.now() - s0;
      // Playwright messages and checks can embed full URLs: strip their query strings before saving.
      entry.checks = session.checks.map(redactText);
      entry.findings = session.findings.map((f) => ({ ...f, text: redactText(f.text) }));
      if (session.consoleErrors.length)
        entry.consoleErrors = session.consoleErrors.slice(0, 12).map(redactText);
      for (const [k, v] of Object.entries(state))
        if (JSON.stringify(before[k]) !== JSON.stringify(v))
          entry.records[k] = typeof v === 'string' ? redactText(v) : v;
      writeState(stateFile, workflow.name, state);
      log(`${entry.status} ${step.id} (${(entry.durationMs / 1000).toFixed(1)} s)`);
    }
  } catch (error) {
    // A driver error outside a step (e.g. saving results): keep what ran and report it.
    result.status = 'FAIL';
    result.error = redactText(`Driver error: ${error.message.split('\n')[0]}`);
    log(result.error);
  } finally {
    // Videos are written when their page's context closes; always close, even after an error.
    const pages = context.pages();
    const extra = session.extraContexts ?? [];
    await context.close().catch(() => {});
    for (const c of extra) await c.context.close().catch(() => {});
    await browser.close().catch(() => {});
    // One suffix for the run's main video (sales.webm, then sales-2.webm …); extra pages and
    // windows take it too and are themselves never overwritten.
    const stem = path.basename(uniquePath(cfg.outDir, base, '.webm'), '.webm');
    let n = 0;
    for (const p of pages) {
      const v = await p
        .video()
        ?.path()
        .catch(() => null);
      if (v && existsSync(v)) {
        const dest =
          n === 0
            ? path.join(cfg.outDir, `${stem}.webm`)
            : uniquePath(cfg.outDir, `${stem}-page${n + 1}`, '.webm');
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
          const dest = uniquePath(cfg.outDir, `${stem}-${c.name}`, '.webm');
          renameSync(v, dest);
          result.videos.push(dest);
        }
      }
    }
  }
  result.finishedAt = now();
  result.wallMs = Date.now() - t0;
  if (result.status !== 'FAIL' && result.steps.every((s) => s.status === 'SKIPPED'))
    result.status = 'SKIPPED';
  return saveResults(cfg, result, earlier);
}

export function withTimeout(promise, ms, message, onTimeout = () => {}) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        Promise.resolve()
          .then(onTimeout)
          .catch(() => {})
          .finally(() => reject(new StepFailure(message)));
      }, ms);
    }),
  ]);
}

/**
 * `--from` skips the steps before it; keep those steps' results from the earlier run, add the new
 * video segment, and derive the workflow status from the combined steps.
 */
function mergeResumed(prev, next) {
  const before = new Map(prev.steps.map((st) => [st.id, st]));
  // A run that could not start has no steps of its own: show the earlier ones.
  const steps = next.steps.length
    ? next.steps.map((st) =>
        st.status === 'SKIPPED' && before.has(st.id) && before.get(st.id).status !== 'SKIPPED'
          ? { ...before.get(st.id), fromEarlierRun: true }
          : st,
      )
    : prev.steps.map((st) => ({ ...st, fromEarlierRun: true }));
  const has = (status) => steps.some((st) => st.status === status);
  const status =
    next.error || has('FAIL')
      ? 'FAIL'
      : has('BLOCKED')
        ? 'BLOCKED'
        : steps.every((st) => st.status === 'PASS')
          ? 'PASS'
          : next.status;
  const videos = [...new Set([...(prev.videos ?? []), ...next.videos])];
  return { ...next, steps, status, videos, wallMs: (prev.wallMs ?? 0) + next.wallMs };
}

export function saveResults(cfg, workflowResult, earlier = null) {
  const file = path.join(cfg.outDir, 'results.json');
  const all = readJson(file, {
    label: cfg.label,
    viewport: cfg.viewportText,
    appUrl: cfg.appUrl,
    workflows: {},
  });
  const merged = earlier ? mergeResumed(earlier, workflowResult) : workflowResult;
  // An unfinished run stays RUNNING; if no later save replaces it, the run was interrupted.
  if (workflowResult.status === 'RUNNING') merged.status = 'RUNNING';
  placeResult(all, workflowResult.name, merged);
  all.updatedAt = now();
  writeJson(file, all);
  writeFileSync(path.join(cfg.outDir, 'results.md'), renderMarkdown(all));
  return all.workflows[workflowResult.name];
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
    if (wf.error) lines.push('', `**${wf.error}**`);
    for (const v of wf.videos) lines.push(`- video: ${v}`);
    lines.push('', '| step | status | s | notes |', '|---|---|---|---|');
    for (const s of wf.steps) {
      const notes = [
        s.fromEarlierRun && '(from the earlier segment)',
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
