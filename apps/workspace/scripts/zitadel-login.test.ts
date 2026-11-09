import type { Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('otplib', () => ({ generate: vi.fn(() => Promise.resolve('test-code')) }));

function clockPage() {
  const waitForTimeout = vi.fn((milliseconds: number) => {
    vi.setSystemTime(Date.now() + milliseconds);
    return Promise.resolve();
  });
  return { page: { waitForTimeout } as unknown as Page, waitForTimeout };
}

// Public RFC 6238 example material, not a seeded persona's credential.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('fresh TOTP windows across Playwright worker lifetimes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:05Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a new window on first use, when an earlier worker may have consumed this code', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    expect(waitForTimeout).toHaveBeenCalledExactlyOnceWith(25_250);
    expect(Date.now()).toBe(new Date('2030-01-01T00:00:30.250Z').getTime());
  });

  it('also waits when a replacement worker has forgotten the previous worker used the current window', async () => {
    const original = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await original.freshTotpCode(SECRET, page);
    vi.resetModules();
    const replacement = await import('../e2e/helpers/zitadel-login');
    await replacement.freshTotpCode(SECRET, page);
    expect(waitForTimeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      25_250, 30_000,
    ]);
  });

  it('continues preventing replay in one worker, including equivalent secret formatting', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    await freshTotpCode(` ${SECRET.toLowerCase()} `, page);
    expect(waitForTimeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      25_250, 30_000,
    ]);
  });

  it('does not add a wait on a later unused window with enough time left', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    vi.setSystemTime(new Date('2030-01-01T00:01:05Z'));
    await freshTotpCode(SECRET, page);
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
  });

  it('waits only once near the end of a first-use window', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    vi.setSystemTime(new Date('2030-01-01T00:00:29Z'));
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    expect(waitForTimeout).toHaveBeenCalledExactlyOnceWith(1_250);
  });
});
