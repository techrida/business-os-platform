// What a run keeps on disk between invocations, written so nothing is overwritten silently:
// - state.json holds each workflow's records separately: { version: 2, workflows: { sales: {…} } }.
//   A file from before version 2 (one flat object) is kept as `legacy` and read for every workflow.
// - results.json keeps every earlier result of a workflow under `history`, and video and screenshot
//   names get a -2, -3 … suffix instead of replacing an existing file.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
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

/** A lock file that is empty or unreadable this young may be mid-write by its owner: held. */
export const LOCK_YOUNG_MS = 10_000;

const readRaw = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return '';
  }
};

const ageMs = (file) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Why the lock in `file` (its content `raw`) is still held, or null when it is stale.
 * A lock without a hostname is from this tool before 20 Nov 2026 and counts as this machine's.
 */
function heldBy(file, raw, { breakLock }) {
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    // empty or partly written
  }
  if (!holder || typeof holder !== 'object') {
    return ageMs(file) < LOCK_YOUNG_MS ? 'a lock that is being written right now' : null;
  }
  const since = holder.startedAt ? `, since ${holder.startedAt}` : '';
  if (holder.hostname && holder.hostname !== hostname()) {
    if (breakLock) return null;
    return (
      `another machine (${holder.hostname}, pid ${holder.pid}${since}); its process cannot be ` +
      'checked from here. Pass --break-lock only if that run is gone'
    );
  }
  if (Number.isInteger(holder.pid) && alive(holder.pid))
    return `another manual-run (pid ${holder.pid}${since})`;
  return null;
}

/**
 * One run per output folder at a time. The lock file `<dir>/<name>` is written completely under a
 * temporary name and then hard-linked into place (`link` fails with EEXIST when it exists), so no
 * other process ever sees a half-written lock of ours. It holds pid, hostname, start time and a
 * unique token; release removes it only while it still carries that token.
 *
 * Held: a live pid on this machine, any lock from another hostname (unless `breakLock`), and an
 * empty or unreadable lock younger than LOCK_YOUNG_MS. A stale lock is moved aside with an atomic
 * rename to a unique name; only the process whose rename succeeded re-checks the moved content
 * against what it judged stale, removes it and retries. If the content differs it moved a fresh
 * lock: it links that back and reports the folder held. Returns a release function; throws when
 * the lock is held.
 */
export function acquireLock(dir, { name = '.lock', breakLock = false } = {}) {
  const file = path.join(dir, name);
  const token = `${hostname()}:${process.pid}:${randomUUID()}`;
  const content = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token,
  });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmp, file);
        return () => {
          if (readRaw(file) === content) rmSync(file, { force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const raw = readRaw(file);
      if (raw === null) continue; // released in the meantime
      const why = heldBy(file, raw, { breakLock });
      if (why)
        throw new Error(`${dir} is in use by ${why}. Wait for it to finish, or use another label.`);
      const aside = `${file}.stale.${process.pid}.${randomUUID()}`;
      try {
        renameSync(file, aside);
      } catch (error) {
        if (error.code === 'ENOENT') continue; // another process moved it first
        throw error;
      }
      if (readRaw(aside) !== raw) {
        // Between the read and the rename another process replaced the stale lock: put it back.
        try {
          linkSync(aside, file);
        } catch {
          // a third process linked its own lock meanwhile; see README (Known limits)
        }
        rmSync(aside, { force: true });
        throw new Error(`${dir} is in use by another manual-run that took it at the same moment.`);
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  throw new Error(`Could not lock ${dir}: other runs kept taking it at the same moment.`);
}

/** Runs `fn` under the lock `<dir>/<name>`, waiting up to `waitMs` for another holder. */
export async function withFileLock(dir, name, fn, { waitMs = 30_000 } = {}) {
  const until = Date.now() + waitMs;
  let release;
  for (;;) {
    try {
      release = acquireLock(dir, { name });
      break;
    } catch (error) {
      if (!/in use by|at the same moment/.test(error.message) || Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  try {
    return await fn();
  } finally {
    release();
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
