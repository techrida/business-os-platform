// What a run keeps on disk between invocations, written so nothing is overwritten silently:
// - state.json holds each workflow's records separately: { version: 2, workflows: { sales: {…} } }.
//   A file from before version 2 (one flat object) is kept as `legacy` and read for every workflow.
// - results.json keeps every earlier result of a workflow under `history`, and video and screenshot
//   names get a -2, -3 … suffix instead of replacing an existing file.
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let tmpCounter = 0;

/** Atomic replace through a temporary file of its own (pid + counter), never a shared name. */
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** `dir/base.ext`, or `dir/base-2.ext`, `dir/base-3.ext` … whichever does not exist yet. */
export function uniquePath(dir, base, ext) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}${ext}`);
    if (!existsSync(p)) return p;
  }
}

/**
 * Like uniquePath, but the name is taken: an empty file is created with O_EXCL (`wx`), so two
 * writers can never get the same name. The caller then renames or writes over its own file.
 */
export function claimPath(dir, base, ext) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}${ext}`);
    try {
      closeSync(openSync(p, 'wx'));
      return p;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, owned by someone else
  }
};

/**
 * One run per output folder at a time: `.lock` is created with O_EXCL and holds the owner's pid. A
 * lock whose process is gone is stale and is taken over (once). Returns a release function; throws
 * when another live process holds the folder.
 */
export function acquireLock(dir) {
  const file = path.join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        if (readJson(file, {}).pid === process.pid) rmSync(file, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readJson(file, null);
    if (holder && Number.isInteger(holder.pid) && alive(holder.pid))
      throw new Error(
        `${dir} is in use by another manual-run (pid ${holder.pid}, since ${holder.startedAt}). ` +
          'Wait for it to finish, or use another label.',
      );
    // Stale: its process is gone (or the file is unreadable). Remove it and try once more.
    rmSync(file, { force: true });
  }
  throw new Error(`Could not lock ${dir}: another run took it at the same moment.`);
}

/** The video name stem of one run: `sales`, `sales-from-sales-7`, `sales-only-sales-3_sales-4`. */
export function videoBase(name, { from, only } = {}) {
  if (from) return `${name}-from-${from}`;
  if (only?.length) return `${name}-only-${only.join('_')}`;
  return name;
}

const isV2 = (raw) => raw && raw.version === 2 && typeof raw.workflows === 'object';

export function readState(file, name) {
  const raw = readJson(file, {});
  if (isV2(raw)) return { ...(raw.workflows[name] ?? raw.legacy ?? {}) };
  return { ...raw };
}

/**
 * @param {{ appUrl?: string, runKey?: string }} meta the stack and run key the records belong to;
 *   kept from the first write on (a resume against another stack is refused by run.mjs).
 */
export function writeState(file, name, state, meta = {}) {
  const raw = readJson(file, {});
  const next = isV2(raw)
    ? raw
    : { version: 2, workflows: {}, ...(Object.keys(raw).length ? { legacy: raw } : {}) };
  for (const [k, v] of Object.entries(meta)) if (v && !next[k]) next[k] = v;
  next.workflows[name] = state;
  writeJson(file, next);
}

/**
 * Which stack and run key an output folder's records belong to: `appUrl` from state.json (or,
 * for a folder from before it was stored there, results.json); `runKey` as stored, else null.
 * `hasRecords` says whether any workflow kept records or ran a step there.
 */
export function readFolderMeta(outDir) {
  const raw = readJson(path.join(outDir, 'state.json'), {});
  const results = readJson(path.join(outDir, 'results.json'), {});
  const v2 = isV2(raw);
  const hasRecords = v2
    ? Object.values(raw.workflows).some((w) => Object.keys(w ?? {}).length) ||
      Boolean(raw.legacy && Object.keys(raw.legacy).length)
    : Object.keys(raw).length > 0;
  const ran = Object.values(results.workflows ?? {}).some((w) =>
    w?.steps?.some((st) => st.status !== 'SKIPPED'),
  );
  return {
    appUrl: (v2 && raw.appUrl) || results.appUrl || null,
    runKey: (v2 && raw.runKey) || null,
    hasRecords: hasRecords || ran,
  };
}

/** Did an earlier invocation run (or start) this workflow in this output folder? */
export function hasEarlierRun(outDir, name) {
  const raw = readJson(path.join(outDir, 'state.json'), {});
  const state = isV2(raw) ? (raw.workflows[name] ?? raw.legacy ?? {}) : raw;
  if (Object.keys(state).length) return true;
  const entry = readJson(path.join(outDir, 'results.json'), {}).workflows?.[name];
  // A run that could not start (no steps) or skipped everything changed nothing on the stack.
  return Boolean(entry?.steps?.some((st) => st.status !== 'SKIPPED'));
}

/**
 * `--fresh`: this workflow starts over in this folder. Its records are cleared (a copy of the old
 * state.json is kept next to it); its earlier result moves to `history` on the first save.
 */
export function resetWorkflow(outDir, name) {
  const file = path.join(outDir, 'state.json');
  if (!existsSync(file)) return null;
  const backup = claimPath(outDir, 'state-before-fresh', '.json');
  copyFileSync(file, backup);
  const raw = readJson(file, {});
  const next = isV2(raw)
    ? raw
    : { version: 2, workflows: {}, ...(Object.keys(raw).length ? { legacy: raw } : {}) };
  next.workflows[name] = {};
  writeJson(file, next);
  return backup;
}

/**
 * Puts `entry` in `all.workflows[name]`. An entry from a different run (another runId) moves to
 * `all.history[name]` first, so a later run never erases an earlier one's results.
 */
export function placeResult(all, name, entry) {
  const prev = all.workflows[name];
  if (prev && prev.runId !== entry.runId && prev.status !== 'NOT-IMPLEMENTED') {
    all.history ??= {};
    (all.history[name] ??= []).push(prev);
  }
  all.workflows[name] = entry;
  return all;
}
