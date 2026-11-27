// @vitest-environment jsdom
// The wait schedule for a PDF that is being prepared (round 7, U1-18): the first check after 1 s, then 2 s, 4 s, 8 s,
// 15 s and 30 s pauses. The check only reports; the screen decides when to refresh.
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { preparePollDelayMs, usePreparePoll } from './use-prepare-poll';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
const check = vi.fn();

function Probe({ active }: { active: boolean }) {
  usePreparePoll(active, check);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(() => {
    vi.advanceTimersByTime(ms);
    return Promise.resolve();
  });
}

it('pauses 1 s, 2 s, 4 s, 8 s, 15 s and then 30 s each', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 20].map(preparePollDelayMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
  ]);
});

it('runs the first check at 1,000 ms and none before it', async () => {
  mounted = await mountForm(createElement(Probe, { active: true }));
  await advance(999);
  expect(check).not.toHaveBeenCalled();
  await advance(1);
  expect(check).toHaveBeenCalledTimes(1);
});

it('keeps the schedule: checks at 1, 3, 7, 15, 30 and 60 seconds', async () => {
  mounted = await mountForm(createElement(Probe, { active: true }));
  let elapsed = 0;
  for (const [at, calls] of [
    [1_000, 1],
    [3_000, 2],
    [7_000, 3],
    [15_000, 4],
    [30_000, 5],
    [60_000, 6],
  ] as const) {
    await advance(at - elapsed);
    elapsed = at;
    expect(check).toHaveBeenCalledTimes(calls);
  }
});

it('makes no check while inactive', async () => {
  mounted = await mountForm(createElement(Probe, { active: false }));
  await advance(120_000);
  expect(check).not.toHaveBeenCalled();
});
