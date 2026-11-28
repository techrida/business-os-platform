import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Locator } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { timeAction } from '../e2e/helpers/flow-timing';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'qa-flow-timing-'));
  file = path.join(dir, 'timing.jsonl');
  vi.stubEnv('BOS_QA_FLOW_TIMINGS_FILE', file);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fakeButton() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const page = Object.assign(new EventEmitter(), { url: () => 'https://app.localhost/' });
  const request = { url: () => 'https://app.localhost/inbox' };
  const prior = { url: () => 'https://app.localhost/inbox' };
  const response = (req: object, id: string) => ({
    request: () => req,
    headers: () => ({ 'x-request-id': id }),
  });
  const click = vi.fn((options?: { trial: boolean }) => {
    if (options?.trial) {
      now += 1000;
      page.emit('request', prior);
    } else {
      now += 15;
      page.emit('response', response(prior, 'prior-request'));
      page.emit('request', request);
      page.emit('response', response(request, 'action-request'));
      page.emit('response', response(request, 'action-request'));
    }
    return Promise.resolve();
  });
  return {
    page,
    button: { click, page: () => page } as unknown as Locator,
    click,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('timeAction', () => {
  it('excludes readiness and earlier in-flight responses, times to the result and deduplicates IDs', async () => {
    const { page, button, click, advance } = fakeButton();
    await timeAction('approve-step-1', button, () => {
      advance(25);
      return Promise.resolve();
    });
    expect(click.mock.calls).toEqual([[{ trial: true }], []]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      name: 'approve-step-1',
      pageMs: 40,
      ok: true,
      requestIds: ['action-request'],
    });
    expect(page.listenerCount('request')).toBe(0);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('records a failed assertion then rethrows, and allows a retry result of false', async () => {
    const { page, button } = fakeButton();
    await expect(
      timeAction('record-payment', button, () => Promise.reject(new Error('not visible'))),
    ).rejects.toThrow('not visible');
    expect(await timeAction('record-payment', button, () => Promise.resolve(false))).toBe(false);
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ok: boolean });
    expect(rows.map((row) => row.ok)).toEqual([false, false]);
    expect(page.listenerCount('response')).toBe(0);
  });
});
