// What a run keeps on disk between invocations, written so nothing is overwritten silently:
// - state.json holds each workflow's records separately: { version: 2, workflows: { sales: {…} } }.
//   A file from before version 2 (one flat object) is kept as `legacy` and read for every workflow.
// - results.json keeps every earlier result of a workflow under `history`, and video and screenshot
//   names get a -2, -3 … suffix instead of replacing an existing file.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** `dir/base.ext`, or `dir/base-2.ext`, `dir/base-3.ext` … whichever does not exist yet. */
export function uniquePath(dir, base, ext) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}${ext}`);
    if (!existsSync(p)) return p;
  }
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

export function writeState(file, name, state) {
  const raw = readJson(file, {});
  const next = isV2(raw)
    ? raw
    : { version: 2, workflows: {}, ...(Object.keys(raw).length ? { legacy: raw } : {}) };
  next.workflows[name] = state;
  writeJson(file, next);
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
  const backup = uniquePath(outDir, 'state-before-fresh', '.json');
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
