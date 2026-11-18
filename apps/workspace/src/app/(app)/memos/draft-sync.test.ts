import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoDraftSnapshot, MemoDraftValues } from '@/lib/memo-working-draft-types';

import { createDraftSync, type SyncState } from './draft-sync';
import type { DraftLoad, DraftTransport, DraftWrite } from './draft-transport';

const EMPTY: MemoDraftValues = { title: '', body: '', amount: '', currency: 'NPR' };
const v = (over: Partial<MemoDraftValues>): MemoDraftValues => ({ ...EMPTY, ...over });
const snap = (revision: string | null, values: MemoDraftValues | null): MemoDraftSnapshot => ({
  revision,
  values,
  updatedAt: null,
});

/** A scriptable transport: each call takes the next queued answer, or a default success that bumps the revision. */
function fakeTransport() {
  const calls: { op: string; revision: string | null; values?: MemoDraftValues }[] = [];
  const loads: DraftLoad[] = [];
  const writes: DraftWrite[] = [];
  let n = 0;
  const gates: (() => void)[] = [];
  let hold = false;
  const transport: DraftTransport = {
    load() {
      calls.push({ op: 'load', revision: null });
      return Promise.resolve(loads.shift() ?? { kind: 'ok', snapshot: snap(null, null) });
    },
    async save(revision, values) {
      calls.push({ op: 'save', revision, values });
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      n += 1;
      return writes.shift() ?? { kind: 'ok', snapshot: snap(`rev${n}`, values) };
    },
    discard(revision) {
      calls.push({ op: 'discard', revision });
      return Promise.resolve(writes.shift() ?? { kind: 'ok', snapshot: snap(`gone${n}`, null) });
    },
  };
  return {
    transport,
    calls,
    loads,
    writes,
    holdSaves: () => (hold = true),
    release: () => gates.shift()?.(),
  };
}

function setup(over: { baseline?: MemoDraftValues } = {}) {
  const t = fakeTransport();
  const states: SyncState[] = [];
  const restored: MemoDraftValues[] = [];
  const engine = createDraftSync({
    transport: t.transport,
    baseline: over.baseline ?? EMPTY,
    onState: (s) => states.push(s),
    onRestore: (values) => restored.push(values),
  });
  return { t, engine, states, restored, last: () => states[states.length - 1]! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('first read', () => {
  it('never writes before the stored draft has been read', async () => {
    const s = setup();
    s.engine.update(v({ body: 'typed early' }));
    await settle(60_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toEqual([]);
    s.engine.start();
    await settle(2000);
    // The read answered "nothing stored": the early text is now saved, against the revision the server named.
    expect(s.t.calls.map((c) => c.op)).toEqual(['load', 'save']);
  });

  it('restores a stored draft into the form and does not write it back', async () => {
    const s = setup();
    s.t.loads.push({ kind: 'ok', snapshot: snap('r1', v({ body: 'earlier work' })) });
    s.engine.start();
    await settle();
    expect(s.restored).toEqual([v({ body: 'earlier work' })]);
    s.engine.update(v({ body: 'earlier work' }));
    await settle(30_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toEqual([]);
    expect(s.last().status).toBe('saved');
  });

  it('treats text typed before the stored draft arrived as a conflict, not an overwrite', async () => {
    const s = setup();
    s.engine.update(v({ body: 'typed first' }));
    s.t.loads.push({ kind: 'ok', snapshot: snap('r1', v({ body: 'stored' })) });
    s.engine.start();
    await settle(30_000);
    expect(s.last().status).toBe('conflict');
    expect(s.last().conflict?.kind).toBe('changed');
    expect(s.t.calls.filter((c) => c.op === 'save')).toEqual([]);

    s.engine.resolveConflict('theirs');
    expect(s.restored).toEqual([v({ body: 'stored' })]);
    expect(s.last().status).toBe('saved');
  });

  it('keeping my version saves over the stored draft using its revision', async () => {
    const s = setup();
    s.engine.update(v({ body: 'typed first' }));
    s.t.loads.push({ kind: 'ok', snapshot: snap('r1', v({ body: 'stored' })) });
    s.engine.start();
    await settle();
    s.engine.resolveConflict('mine');
    await settle();
    expect(s.t.calls.at(-1)).toMatchObject({
      op: 'save',
      revision: 'r1',
      values: v({ body: 'typed first' }),
    });
  });
});

describe('saving', () => {
  it('waits for the person to pause, then saves once with the newest text', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    for (const body of ['h', 'he', 'hel', 'hell', 'hello']) {
      s.engine.update(v({ body }));
      await settle(300);
    }
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(0);
    await settle(1500);
    expect(s.t.calls.filter((c) => c.op === 'save')).toMatchObject([
      { values: v({ body: 'hello' }) },
    ]);
    expect(s.last().status).toBe('saved');
  });

  it('checkpoints during continuous typing instead of waiting for a pause', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    for (let i = 1; i <= 60; i += 1) {
      s.engine.update(v({ body: 'x'.repeat(i) }));
      await settle(400); // never a 1.5 s pause
    }
    expect(s.t.calls.filter((c) => c.op === 'save').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps one write in flight and chains the next with the revision the first returned', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.holdSaves();
    s.engine.update(v({ body: 'one' }));
    await settle(1500);
    s.engine.update(v({ body: 'two' })); // typed while the first request is still out
    const flushed = s.engine.flush(); // e.g. the tab is hidden now
    await settle();
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(1);
    s.t.release();
    await settle();
    s.t.release();
    await flushed;
    const saves = s.t.calls.filter((c) => c.op === 'save');
    expect(saves.map((c) => [c.revision, c.values?.body])).toEqual([
      [null, 'one'],
      ['rev1', 'two'],
    ]);
    expect(s.last().status).toBe('saved');
  });

  it('adopts a 409 that carries exactly what was sent (the answer was lost) and does not bother the person', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'conflict', current: snap('r9', v({ body: 'mine' })) });
    s.engine.update(v({ body: 'mine' }));
    await settle(1500);
    expect(s.last().status).toBe('saved');
    expect(s.last().conflict).toBeNull();
    s.engine.update(v({ body: 'mine, more' }));
    await settle(1500);
    expect(s.t.calls.at(-1)).toMatchObject({ revision: 'r9' });
  });

  it('stops and asks on a 409 with different content, and never overwrites without an answer', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'conflict', current: snap('r9', v({ body: 'from another tab' })) });
    s.engine.update(v({ body: 'mine' }));
    await settle(1500);
    expect(s.last().status).toBe('conflict');
    s.engine.update(v({ body: 'mine again' }));
    await settle(60_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(1);
  });

  it('reports a draft removed elsewhere as its own kind of conflict', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'conflict', current: snap('tomb1', null) });
    s.engine.update(v({ body: 'late tab' }));
    await settle(1500);
    expect(s.last().conflict?.kind).toBe('removed');
    s.engine.resolveConflict('mine');
    await settle(1500);
    expect(s.t.calls.at(-1)).toMatchObject({ op: 'save', revision: 'tomb1' });
  });

  it('goes offline on a network failure, keeps the text, and retries by itself', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'unavailable', message: 'paused' });
    s.engine.update(v({ body: 'text' }));
    await settle(1500);
    expect(s.last().status).toBe('offline');
    expect(s.engine.hasUnsaved()).toBe(true);
    await settle(2000);
    expect(s.last().status).toBe('saved');
    expect(s.engine.hasUnsaved()).toBe(false);
  });

  it('blocks on a refusal and says why; a signed-out block retries when the person returns', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'signed-out', message: 'Sign in to continue.' });
    s.engine.update(v({ body: 'text' }));
    await settle(1500);
    expect(s.last()).toMatchObject({ status: 'blocked', message: 'Sign in to continue.' });
    await settle(60_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(1);
    s.engine.retryNow();
    await settle();
    expect(s.last().status).toBe('saved');
  });

  it('a refusal for another account (403) is not retried on return', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'denied', message: 'The signed-in account changed.' });
    s.engine.update(v({ body: 'text' }));
    await settle(1500);
    s.engine.retryNow();
    await settle(60_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(1);
    expect(s.last().status).toBe('blocked');
  });
});

describe('a draft exists only while it differs from the baseline', () => {
  it('typing back to the original deletes the stored copy instead of saving a duplicate of it', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.engine.update(v({ body: 'changed' }));
    await settle(1500);
    s.engine.update(EMPTY);
    await settle(1500);
    expect(s.t.calls.at(-1)).toEqual({ op: 'discard', revision: 'rev1' });
    expect(s.last().status).toBe('idle');
  });

  it('a stored copy equal to the baseline is stale: it is cleaned up, not restored', async () => {
    const s = setup();
    s.t.loads.push({ kind: 'ok', snapshot: snap('r1', EMPTY) });
    s.engine.start();
    await settle(1500);
    expect(s.restored).toEqual([]);
    expect(s.t.calls.at(-1)).toEqual({ op: 'discard', revision: 'r1' });
  });
});

describe('leaving, submitting, deleting', () => {
  it('detects a later edit that the in-flight request cannot carry through navigation', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.holdSaves();
    s.engine.update(v({ body: 'already being written' }));
    void s.engine.flush();
    expect(s.engine.hasQueuedWrite()).toBe(false);
    s.engine.update(v({ body: 'a newer keystroke' }));
    expect(s.engine.hasQueuedWrite()).toBe(true);
  });

  it('flush saves at once (tab hidden, page leaving) without waiting for the pause', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.engine.update(v({ body: 'half a sentence' }));
    await s.engine.flush();
    expect(s.t.calls.at(-1)).toMatchObject({ op: 'save', values: v({ body: 'half a sentence' }) });
  });

  it('dispose writes the last keystrokes (navigating away inside the app)', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.engine.update(v({ body: 'last words' }));
    s.engine.dispose();
    await settle();
    expect(s.t.calls.at(-1)).toMatchObject({ op: 'save', values: v({ body: 'last words' }) });
  });

  it('a frozen engine (submit in progress) writes nothing more, and resumes only on request', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.engine.update(v({ body: 'ready' }));
    await s.engine.settle();
    const saved = s.t.calls.filter((c) => c.op === 'save').length;
    s.engine.freeze();
    s.engine.update(v({ body: 'ready, edited during submit' }));
    await settle(60_000);
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(saved);
    expect(s.engine.revision()).toBe('rev1');
    s.engine.resume();
    await settle(1500);
    expect(s.t.calls.filter((c) => c.op === 'save')).toHaveLength(saved + 1);
  });

  it('settle gives up after its timeout when the network hangs', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.holdSaves();
    s.engine.update(v({ body: 'x' }));
    let done = false;
    void s.engine.settle(3000).then(() => (done = true));
    await settle(2900);
    expect(done).toBe(false);
    await settle(200);
    expect(done).toBe(true);
  });

  it('discard deletes the stored copy with the latest revision; a resumed engine then saves again', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.engine.update(v({ body: 'to delete' }));
    await settle(1500);
    expect(await s.engine.discard()).toBe(true);
    expect(s.t.calls.at(-1)).toEqual({ op: 'discard', revision: 'rev1' });
    s.engine.resume(); // the follow-up failed: the text on screen must not be lost
    await settle(1500);
    expect(s.t.calls.at(-1)).toMatchObject({ op: 'save', revision: 'gone1' });
  });

  it('discard retries once over a newer copy: the person asked for it to be gone', async () => {
    const s = setup();
    s.engine.start();
    await settle();
    s.t.writes.push({ kind: 'conflict', current: snap('newer', v({ body: 'x' })) });
    expect(await s.engine.discard()).toBe(true);
    expect(s.t.calls.filter((c) => c.op === 'discard').map((c) => c.revision)).toEqual([
      null,
      'newer',
    ]);
  });
});
