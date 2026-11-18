// The autosave engine for the memo form: framework-free, so its rules are tested with a fake transport and fake timers.
// The React side (use-memo-draft-sync.ts) only forwards events to it.
//
// What it guarantees:
// - Nothing is written before the first read has answered, so a stored draft is never overwritten blind. Typing that
//   happened before the answer is a conflict the person decides, never a silent overwrite.
// - One write in flight at a time, always with the newest values, always with the revision the server last gave.
// - A 409 whose content is exactly what we just sent means our own write landed and the answer was lost: adopted
//   silently. Any other 409 is shown to the person; typed text is never replaced without their say.
// - The dirty text lives in memory only. The durable copy is the server's (per account); nothing is kept in
//   localStorage, so another account on the same browser can never read it.
import type { MemoDraftSnapshot, MemoDraftValues } from '@/lib/memo-working-draft-types';

import type { DraftTransport } from './draft-transport';

export type SyncStatus =
  'loading' | 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'conflict' | 'blocked' | 'frozen';

/** `changed`: the server holds different content (another tab, or an earlier visit). `removed`: it was deleted. */
export interface DraftConflict {
  kind: 'changed' | 'removed';
  current: MemoDraftSnapshot;
}

export interface SyncState {
  status: SyncStatus;
  conflict: DraftConflict | null;
  /** The reason saving stopped (blocked or offline), in words for a person. */
  message: string | null;
  /** True once the server has held a draft for this form at least once this visit. */
  hasSaved: boolean;
}

export interface SyncOptions {
  transport: DraftTransport;
  /** What the form starts with: empty for a new memo, the saved values for an edit. Equal to this means "no draft". */
  baseline: MemoDraftValues;
  onState: (state: SyncState) => void;
  /** The form should show these values (a draft was restored, or the person took the other version). */
  /** `loaded`: a stored draft was found on open. `chosen`: the person picked the saved version in a conflict. */
  onRestore: (values: MemoDraftValues, reason: 'loaded' | 'chosen') => void;
  debounceMs?: number;
  /** Continuous typing still checkpoints this often. */
  maxWaitMs?: number;
  retryDelaysMs?: readonly number[];
}

/** Stable text of a values object, for equality and dirty checks. */
export function keyOf(values: MemoDraftValues): string {
  return JSON.stringify([
    values.title,
    values.body,
    values.amount,
    values.currency,
    values.template ?? '',
  ]);
}

/** Browsers budget about 64 KiB of keepalive bodies per page; stay under it and fall back to a normal request. */
const KEEPALIVE_BUDGET = 60_000;
const NEVER_PERSISTED = '\u0000never';

export interface DraftSync {
  start(): void;
  update(values: MemoDraftValues): void;
  /** Writes now if there is something to write. Resolves when nothing more is pending (or saving cannot proceed). */
  flush(): Promise<void>;
  /** `flush`, bounded: resolves after `timeoutMs` even if the network hangs. Use before a form submit or sign-out. */
  settle(timeoutMs?: number): Promise<void>;
  /** Stops all writes (a submit is in progress). */
  freeze(): void;
  resume(): void;
  /** Deletes the server's copy. The engine stays frozen; call `resume()` if what follows fails. */
  discard(): Promise<boolean>;
  resolveConflict(choice: 'mine' | 'theirs'): void;
  /** Retry now: the network came back or the tab became visible. */
  retryNow(): void;
  /** Text typed that the server does not have yet. */
  hasUnsaved(): boolean;
  /** Text queued behind a save already in flight cannot be included in an unload request. */
  hasQueuedWrite(): boolean;
  /** The latest revision, for the server action to clear the draft against. */
  revision(): string | null;
  /** Final write of anything pending, then stop. Safe to call twice. */
  dispose(): void;
}

export function createDraftSync(options: SyncOptions): DraftSync {
  const debounceMs = options.debounceMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const retryDelays = options.retryDelaysMs ?? [2000, 5000, 15_000, 30_000];
  const baselineKey = keyOf(options.baseline);

  let revision: string | null = null;
  let persisted = baselineKey;
  let latest = options.baseline;
  let touched = false;
  let loaded = false;
  let frozen = false;
  let closed = false;
  let hasSaved = false;
  let stopped: 'conflict' | 'blocked' | null = null;
  /** Signing in again elsewhere can fix this kind of block, so a returning tab tries again. */
  let signedOut = false;
  let status: SyncStatus = 'loading';
  let conflict: DraftConflict | null = null;
  let message: string | null = null;
  let running: Promise<void> | null = null;
  let writingKey: string | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let maxWait: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryIndex = 0;

  const dirty = () => keyOf(latest) !== persisted;
  const canSave = () => loaded && !frozen && stopped === null;

  function emit(next: SyncStatus) {
    status = next;
    if (!closed) options.onState({ status, conflict, message, hasSaved });
  }

  function clearTimers() {
    clearTimeout(debounce);
    clearTimeout(maxWait);
    clearTimeout(retry);
    debounce = maxWait = retry = undefined;
  }

  function settledStatus(): SyncStatus {
    return dirty() ? 'dirty' : hasSaved ? 'saved' : 'idle';
  }

  function schedule() {
    if (closed || !canSave()) return;
    if (!dirty()) {
      clearTimeout(debounce);
      clearTimeout(maxWait);
      debounce = maxWait = undefined;
      if (status !== 'saving') emit(settledStatus());
      return;
    }
    if (status !== 'saving' && status !== 'offline') emit('dirty');
    clearTimeout(debounce);
    debounce = setTimeout(() => void flush(), debounceMs);
    maxWait ??= setTimeout(() => void flush(), maxWaitMs);
  }

  function scheduleRetry() {
    clearTimeout(retry);
    const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)] ?? 30_000;
    retryIndex += 1;
    retry = setTimeout(() => {
      if (!loaded) start();
      else void flush();
    }, delay);
  }

  function stop(kind: 'conflict' | 'blocked', nextMessage: string | null, needsSignIn = false) {
    stopped = kind;
    signedOut = needsSignIn;
    message = nextMessage;
    clearTimers();
    emit(kind);
  }

  /** One write of the newest values. True means it landed (or was adopted) and the loop may check for more. */
  async function saveOnce(): Promise<boolean> {
    const sent = latest;
    const sentKey = keyOf(sent);
    emit('saving');
    // Text identical to what the memo (or an empty form) already is has nothing to keep: the server's copy is
    // deleted, so a working draft exists only while it differs from the baseline.
    const unchanged = sentKey === baselineKey;
    const keepalive = new TextEncoder().encode(sentKey).length < KEEPALIVE_BUDGET;
    writingKey = sentKey;
    const result = await (
      unchanged
        ? options.transport.discard(revision)
        : options.transport.save(revision, sent, keepalive)
    ).finally(() => {
      writingKey = null;
    });
    switch (result.kind) {
      case 'ok':
        revision = result.snapshot.revision;
        persisted = sentKey;
        hasSaved = !unchanged;
        retryIndex = 0;
        message = null;
        emit(settledStatus());
        return true;
      case 'conflict': {
        const current = result.current;
        if (current.values !== null && keyOf(current.values) === sentKey) {
          // Our own write landed and its answer was lost.
          revision = current.revision;
          persisted = sentKey;
          hasSaved = !unchanged;
          emit(settledStatus());
          return true;
        }
        if (current.values === null && current.revision === null) {
          revision = null; // the server forgot the draft; start it again
          return true;
        }
        conflict = { kind: current.values === null ? 'removed' : 'changed', current };
        stop('conflict', null);
        return false;
      }
      case 'unavailable':
        message = result.message;
        clearTimeout(debounce);
        emit('offline');
        scheduleRetry();
        return false;
      default:
        stop('blocked', result.message, result.kind === 'signed-out');
        return false;
    }
  }

  function drain(): Promise<void> {
    if (running) return running;
    if (!dirty() || !canSave()) return Promise.resolve();
    running = (async () => {
      try {
        let rounds = 0;
        while (dirty() && canSave() && rounds < 20) {
          rounds += 1;
          if (!(await saveOnce())) break;
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function flush(): Promise<void> {
    clearTimeout(debounce);
    clearTimeout(maxWait);
    debounce = maxWait = undefined;
    if (!canSave()) {
      await running;
      return;
    }
    await drain();
  }

  function start() {
    void (async () => {
      const result = await options.transport.load();
      if (closed) return;
      if (result.kind === 'unavailable') {
        message = result.message;
        emit('offline');
        scheduleRetry();
        return;
      }
      if (result.kind !== 'ok') {
        stop('blocked', result.message, result.kind === 'signed-out');
        return;
      }
      const { snapshot } = result;
      revision = snapshot.revision;
      loaded = true;
      retryIndex = 0;
      message = null;
      if (snapshot.values !== null) {
        const key = keyOf(snapshot.values);
        hasSaved = key !== baselineKey;
        if (key === baselineKey) {
          // A stored copy equal to the baseline is stale: leave `persisted` unequal so it is deleted on the next write.
          persisted = NEVER_PERSISTED;
        } else if (!touched) {
          persisted = key;
          latest = snapshot.values;
          options.onRestore(snapshot.values, 'loaded');
        } else {
          // The person typed before the stored draft arrived. They decide which one stays.
          conflict = { kind: 'changed', current: snapshot };
          stop('conflict', null);
          return;
        }
      }
      schedule();
      if (!dirty()) emit(settledStatus());
    })();
  }

  return {
    start,
    update(values) {
      if (closed) return;
      latest = values;
      touched = keyOf(values) !== baselineKey;
      schedule();
    },
    flush,
    async settle(timeoutMs = 4000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([flush(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    freeze() {
      frozen = true;
      clearTimers();
      emit('frozen');
    },
    resume() {
      frozen = false;
      schedule();
      if (!dirty()) emit(settledStatus());
    },
    async discard() {
      frozen = true;
      clearTimers();
      await running;
      let expected = revision;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await options.transport.discard(expected);
        if (result.kind === 'ok') {
          revision = result.snapshot.revision;
          // Whatever is on screen is no longer what the server holds, so a resumed engine saves it again.
          persisted = NEVER_PERSISTED;
          hasSaved = false;
          return true;
        }
        if (result.kind !== 'conflict') return false;
        expected = result.current.revision; // deleting wins over a newer copy: the person asked for it
      }
      return false;
    },
    resolveConflict(choice) {
      if (!conflict) return;
      const { current } = conflict;
      conflict = null;
      stopped = null;
      message = null;
      revision = current.revision;
      if (choice === 'theirs') {
        const values = current.values ?? options.baseline;
        latest = values;
        persisted = keyOf(values);
        touched = persisted !== baselineKey;
        hasSaved = current.values !== null;
        options.onRestore(values, 'chosen');
        emit(settledStatus());
        return;
      }
      persisted = current.values ? keyOf(current.values) : baselineKey;
      schedule();
      void flush();
    },
    retryNow() {
      if (closed || frozen || stopped === 'conflict') return;
      if (stopped === 'blocked') {
        if (!signedOut) return;
        stopped = null;
        message = null;
      }
      clearTimeout(retry);
      retryIndex = 0;
      if (!loaded) start();
      else void flush();
    },
    hasUnsaved() {
      return loaded ? dirty() || running !== null : touched;
    },
    hasQueuedWrite() {
      return writingKey !== null && writingKey !== keyOf(latest);
    },
    revision: () => revision,
    dispose() {
      if (closed) return;
      clearTimers();
      const last = canSave() && dirty();
      closed = true;
      // Leaving the page by a link must not lose the last keystrokes.
      if (last) void drain();
    },
  };
}
