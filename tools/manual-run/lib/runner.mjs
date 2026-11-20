// Runs one workflow's steps in order in one recorded browser context and writes the results.
// A failed step gets a screenshot; the steps after it are BLOCKED; the next workflow still runs.
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launch, newRecordedContext } from './browser.mjs';
import { isStopping, onCleanup } from './cleanup.mjs';
import { configuredOrigins } from './origins.mjs';
import { redactDeep, redactText, redactUrl } from './redact.mjs';

/** The saved status of a run whose steps are done but whose videos are not named yet. Never green. */
export const FINALIZING = 'FINALIZING';
import { LAST_TIMEOUT_KEY, Session, StepFailure } from './session.mjs';
import {
  claimPath,
  placeResult,
  readJson,
  readState,
  videoBase,
  writeJson,
  writeState,
} from './store.mjs';

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const origins = configuredOrigins;

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
  const meta = { appUrl: cfg.appUrl, runKey: cfg.runKey };
  const persist = () => writeState(stateFile, workflow.name, state, meta);
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
  if (opts.from && workflow.steps[fromIndex]?.exploratory)
    throw new Error(`--from ${opts.from}: exploratory step (not scripted)`);

  // Ctrl-C or a kill: save the steps finished so far (saveResults is synchronous, so it completes
  // before the process exits) and the records. Registered once the browser is up, so (cleanup runs
  // newest first) it is saved before the browser closes and before the folder lock is released.
  let finalSaved = false;
  let inFlight = null; // the step entry whose body is running
  let unregister = () => {};
  const checkpoint = () => {
    if (finalSaved) return;
    saveCheckpoint(cfg, { result, earlier, state, persist, inFlight, wallMs: Date.now() - t0 });
  };
  // After the checkpoint, the step that was cut off must not overwrite it with a FAIL.
  const save = (r) => (isStopping() ? null : saveResults(cfg, r, earlier));

  let browser = null;
  let context = null;
  let session = null;
  try {
    browser = await launch(cfg, workflowOrigins(cfg, workflow), origins(cfg));
    context = await newRecordedContext(browser, cfg, videoTmp);
    session = await Session.open({ context, cfg, state, log });
    session.persist = persist;
    session.dirs = { shots: shotsDir, files: filesDir, video: videoTmp };
    session.browser = browser;
    unregister = onCleanup(checkpoint);
  } catch (error) {
    // Nothing ran: record why, so the summary and results.json show it instead of a crash.
    result.status = 'FAIL';
    result.error = redactText(`Could not start: ${error.message.split('\n')[0]}`);
    log(result.error);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    result.finishedAt = now();
    result.wallMs = Date.now() - t0;
    finalSaved = true;
    unregister();
    return saveResults(cfg, result, earlier);
  }

  try {
    let blocked = null;
    for (const [index, step] of workflow.steps.entries()) {
      // Saved before every step, so a run that is killed keeps the results of the steps it finished.
      save({ ...result, status: 'RUNNING', wallMs: Date.now() - t0 });
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
      // An exploratory step has no script: one exploratory agent pass per release covers it.
      if (step.exploratory) {
        entry.status = 'SKIPPED';
        entry.note = step.note ?? 'Exploratory step: not scripted';
        continue;
      }
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
      inFlight = entry;
      try {
        await session.caption(`${step.id} — ${step.title}`);
        const limit = step.timeoutMs ?? cfg.stepTimeout;
        const message = `${step.id} did not finish within ${limit / 1000} s`;
        const body = Promise.resolve().then(() => step.run(session));
        await withTimeout(body, limit, message, async () => {
          // Cancel the step and close its windows at once: pending waits end and sockets close. A
          // request already sent can still commit on the server; the time is kept so the next
          // invocation's adoption lookups wait for it (Session.settleAfterTimeout).
          const aborting = session.abort(message);
          await session.closeWindows();
          await aborting.catch(() => {});
          state[LAST_TIMEOUT_KEY] = now();
          try {
            persist();
          } catch {
            // the results still record the time-out
          }
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
        const shot = claimPath(shotsDir, `${step.id}-FAIL`, '.png');
        // After a time-out the windows are closed and there is nothing to capture.
        const shotTaken = await session.page
          .screenshot({ path: shot, fullPage: true })
          .then(() => true)
          .catch(() => false);
        if (shotTaken) entry.screenshot = shot;
        else rmSync(shot, { force: true });
        log(`FAIL ${step.id}: ${entry.error}`);
        await session.caption(`${step.id} FAILED — ${entry.error.slice(0, 160)}`);
        await sleep(2500); // not session.pause: it refuses to wait once the step is cancelled
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
        if (k !== LAST_TIMEOUT_KEY && JSON.stringify(before[k]) !== JSON.stringify(v))
          entry.records[k] = typeof v === 'string' ? redactText(v) : v;
      inFlight = null;
      persist();
      log(`${entry.status} ${step.id} (${(entry.durationMs / 1000).toFixed(1)} s)`);
      // Saved again as soon as the step ends, so a stop between steps loses nothing.
      save({ ...result, status: 'RUNNING', wallMs: Date.now() - t0 });
    }
  } catch (error) {
    // A driver error outside a step (e.g. saving results): keep what ran and report it.
    result.status = 'FAIL';
    result.error = redactText(`Driver error: ${error.message.split('\n')[0]}`);
    log(result.error);
  }
  // The steps' results are saved before the browser closes and the videos are named: closing and
  // renaming can fail or be interrupted, and must never cost the steps.
  result.finishedAt = now();
  result.wallMs = Date.now() - t0;
  if (result.status !== 'FAIL' && result.steps.every((s) => s.status === 'SKIPPED'))
    result.status = 'SKIPPED';
  // Until the videos are named the run is not green: a stop while the recording context closes
  // must leave a result that is not PASS (the final status is saved below).
  save({ ...result, status: result.status === 'FAIL' ? 'FAIL' : FINALIZING });
  finalSaved = true;
  unregister();
  try {
    await finishVideos(cfg, result, context, session, browser, base);
  } catch (error) {
    // The steps stay as they ran, but the run is not green: its video is part of the evidence.
    result.videoError = redactText(`Videos not finalised: ${error.message.split('\n')[0]}`);
    result.status = 'FAIL';
    log(result.videoError);
  }
  return save(result) ?? result;
}

/**
 * The save of a run stopped by a signal (or an exit). The step in flight becomes INTERRUPTED. A
 * request it sent may still commit after the stop (a payment form sends a fresh idempotency key
 * per render), so the stop counts as a time-out: its time is recorded before the records are
 * written, and the next invocation's adoption lookups wait for it (Session.settleAfterTimeout).
 */
export function saveCheckpoint(cfg, { result, earlier, state, persist, inFlight, wallMs }) {
  state[LAST_TIMEOUT_KEY] = now();
  try {
    persist();
  } catch {
    // the results below still record what ran
  }
  const steps = result.steps.map((st) =>
    st === inFlight
      ? { ...st, status: 'INTERRUPTED', error: 'The run was stopped while this step ran' }
      : st,
  );
  return saveResults(
    cfg,
    { ...result, steps, status: 'RUNNING', interrupted: true, wallMs },
    earlier,
  );
}

/**
 * Videos are written when their page's context closes; always close, even after an error. One
 * claimed name for the run's main video (sales.webm, then sales-2.webm …); extra pages and windows
 * take its stem too, and no file is ever replaced.
 */
export async function finishVideos(cfg, result, context, session, browser, base) {
  // A step that timed out closed its windows already; their pages were kept for this. Playwright
  // drops a closed page from context.pages(), so the main window is the page Session.open created
  // (its Video object outlives the page), never whatever the list still holds.
  const listed = session?.closedPages ?? context.pages();
  const mainPage = session?.page ?? listed[0] ?? null;
  const tabs = listed.filter((p) => p !== mainPage);
  const extra = session.extraContexts ?? [];
  await context.close().catch(() => {});
  for (const c of extra) await c.context.close().catch(() => {});
  await browser.close().catch(() => {});
  const failures = [];
  // The main name is claimed when the first video arrives, so a run without one leaves no file.
  let main = null;
  const stem = () => {
    main ??= claimPath(cfg.outDir, base, '.webm');
    return path.basename(main, '.webm');
  };
  // A tab that closed before its first frame may leave no file: that is noted, not a failure.
  // The main window and named windows always have a video, so a missing one fails the run.
  const place = async (page, claim, what, required = true) => {
    const video = page?.video() ?? null;
    if (!video) {
      // The run's contexts all record: a required window without a recording is a failure.
      if (required) failures.push(`the video of ${what} is missing`);
      return false;
    }
    const v = await video.path().catch(() => null);
    if (!v || !existsSync(v)) {
      if (required) failures.push(`the video of ${what} is missing`);
      else (result.videoNotes ??= []).push(`no video file for ${what}`);
      return false;
    }
    if (required && statSync(v).size === 0) {
      failures.push(`the video of ${what} is empty`);
      return false;
    }
    const dest = claim();
    try {
      renameSync(v, dest);
      result.videos.push(dest);
    } catch (error) {
      failures.push(
        `could not move ${path.basename(v)} out of .video-tmp: ${error.message.split('\n')[0]}`,
      );
      rmSync(dest, { force: true }); // the empty claimed name
    }
    return true;
  };
  // The main window is required; tabs are numbered from 2 whether or not it was placed.
  await place(mainPage, () => (stem(), main), 'the main window');
  let n = 1;
  for (const p of tabs) {
    const placed = await place(
      p,
      () => claimPath(cfg.outDir, `${stem()}-page${n + 1}`, '.webm'),
      `tab ${n + 1}`,
      false,
    );
    if (placed) n++;
  }
  for (const c of extra)
    for (const p of c.pages)
      await place(
        p,
        () => claimPath(cfg.outDir, `${stem()}-${c.name}`, '.webm'),
        `the ${c.name} window`,
      );
  // Only extra windows recorded: the main name was claimed for its stem but holds nothing.
  if (main && !result.videos.includes(main)) rmSync(main, { force: true });
  if (failures.length) throw new Error(failures.join('; '));
}

/**
 * Resolves or rejects like `body` if it settles within `ms`. Otherwise the step has FAILED at that
 * moment, whatever the body does later: `onTimeout` runs (cancel the step, let its current action
 * fail before the screenshot) and the promise rejects with the time-limit message, even if the body
 * resolves meanwhile.
 */
export function withTimeout(body, ms, message, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    let decided = false;
    const timer = setTimeout(() => {
      if (decided) return;
      decided = true;
      const failure = new StepFailure(message);
      Promise.resolve()
        .then(onTimeout)
        .catch(() => {})
        .finally(() => reject(failure));
    }, ms);
    body.then(
      (value) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `--from` skips the steps before it; keep those steps' results from the earlier run, add the new
 * video segment, and derive the workflow status from the combined steps.
 */
function mergeResumed(prev, next) {
  const before = new Map(prev.steps.map((st) => [st.id, st]));
  const ran = new Set(next.steps.map((st) => st.id));
  // A step SKIPPED by this segment's selection keeps its stored result. next.steps is always a
  // prefix of the workflow's steps (a checkpoint stops at the step that ran; a run that could not
  // start has none), so every stored step after it is kept too, in the workflow's order.
  const steps = [
    ...next.steps.map((st) =>
      st.status === 'SKIPPED' && before.has(st.id) && before.get(st.id).status !== 'SKIPPED'
        ? { ...before.get(st.id), fromEarlierRun: true }
        : st,
    ),
    ...prev.steps.filter((st) => !ran.has(st.id)).map((st) => ({ ...st, fromEarlierRun: true })),
  ];
  const has = (status) => steps.some((st) => st.status === status);
  // A step kept from an earlier segment counts as much as one of this segment: an INTERRUPTED one
  // left behind by a stopped run keeps the workflow unfinished until a later segment runs it.
  const status =
    next.error || next.videoError || next.status === 'FAIL' || has('FAIL')
      ? 'FAIL'
      : has('BLOCKED')
        ? 'BLOCKED'
        : has('INTERRUPTED')
          ? 'INTERRUPTED'
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
  // Every string that reaches the files passes the redactor (secrets, URL queries); numbers stay.
  const merged = redactDeep(earlier ? mergeResumed(earlier, workflowResult) : workflowResult);
  // An unfinished run stays RUNNING; if no later save replaces it, the run was interrupted.
  if (workflowResult.status === 'RUNNING' || workflowResult.status === FINALIZING)
    merged.status = workflowResult.status;
  placeResult(all, workflowResult.name, merged);
  all.updatedAt = now();
  writeJson(file, all);
  writeFileSync(path.join(cfg.outDir, 'results.md'), renderMarkdown(all));
  return all.workflows[workflowResult.name];
}

/**
 * The last resort when runWorkflow itself throws: the workflow is saved as FAIL with `message`.
 * If this process already saved a result for it since `since` (ISO time), that entry keeps its
 * steps and only gets the status and the error; otherwise a FAIL entry without steps is written.
 */
export function saveDriverError(cfg, name, message, since) {
  const all = readJson(path.join(cfg.outDir, 'results.json'), { workflows: {} });
  const mine = all.workflows?.[name];
  const ours =
    mine && String(mine.runId ?? '').endsWith(`-${process.pid}`) && (mine.startedAt ?? '') >= since;
  const entry = ours
    ? { ...mine, status: 'FAIL', error: message }
    : {
        name,
        title: '',
        status: 'FAIL',
        steps: [],
        videos: [],
        wallMs: 0,
        error: message,
        runId: `${new Date().toISOString()}-${process.pid}`,
      };
  return saveResults(cfg, entry);
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
    if (wf.videoError) lines.push('', `**${wf.videoError}**`);
    for (const v of wf.videos) lines.push(`- video: ${v}`);
    lines.push('', '| step | status | s | notes |', '|---|---|---|---|');
    for (const s of wf.steps) {
      const notes = [
        s.fromEarlierRun && '(from the earlier segment)',
        s.note,
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
