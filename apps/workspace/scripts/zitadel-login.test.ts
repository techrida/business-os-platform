import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

const waits = (waitForTimeout: ReturnType<typeof clockPage>['waitForTimeout']) =>
  waitForTimeout.mock.calls.map(([milliseconds]) => milliseconds);

// Public RFC 6238 example material, not a seeded persona's credential.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const OTHER_SECRET = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U';

describe('fresh TOTP windows, remembered in a file across Playwright worker lifetimes', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bos-totp-'));
    vi.stubEnv('BOS_E2E_TOTP_STATE_DIR', stateDir);
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:05Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('does not wait on the first sign-in of a secret that no worker has used', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await expect(freshTotpCode(SECRET, page)).resolves.toBe('test-code');
    expect(waitForTimeout).not.toHaveBeenCalled();
    expect(Date.now()).toBe(new Date('2030-01-01T00:00:05Z').getTime());
  });

  it('waits for the next window when the same secret signs in again inside the window', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    await freshTotpCode(SECRET, page);
    expect(waits(waitForTimeout)).toEqual([25_250]);
  });

  it('still waits after a simulated worker restart: an empty in-memory state, the same file', async () => {
    const original = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await original.freshTotpCode(SECRET, page);
    vi.resetModules();
    const replacement = await import('../e2e/helpers/zitadel-login');
    await replacement.freshTotpCode(SECRET, page);
    expect(waits(waitForTimeout)).toEqual([25_250]);
  });

  it('continues preventing replay for equivalent secret formatting', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    await freshTotpCode(` ${SECRET.toLowerCase()} `, page);
    expect(waits(waitForTimeout)).toEqual([25_250]);
  });

  it('keeps each secret apart: a persona that has not signed in yet does not wait for another', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    await freshTotpCode(OTHER_SECRET, page);
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it('does not wait on a later unused window with enough time left', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    vi.setSystemTime(new Date('2030-01-01T00:01:05Z'));
    await freshTotpCode(SECRET, page);
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it('waits near the end of a window even for a secret never seen, once', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    vi.setSystemTime(new Date('2030-01-01T00:00:29Z'));
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    expect(waitForTimeout).toHaveBeenCalledExactlyOnceWith(1_250);
  });

  it('treats an unreadable state file as used, so a torn write cannot cause a replay', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    const { page, waitForTimeout } = clockPage();
    await freshTotpCode(SECRET, page);
    const [file] = readdirSync(stateDir);
    writeFileSync(path.join(stateDir, file as string), '');
    await freshTotpCode(SECRET, page);
    expect(waits(waitForTimeout)).toEqual([25_250]);
  });

  it('stores a hash of the secret, never the secret', async () => {
    const { freshTotpCode } = await import('../e2e/helpers/zitadel-login');
    await freshTotpCode(SECRET, clockPage().page);
    const files = readdirSync(stateDir);
    expect(files).toHaveLength(1);
    const text = [
      files[0] as string,
      readFileSync(path.join(stateDir, files[0] as string), 'utf8'),
    ].join();
    expect(text).not.toContain(SECRET);
    expect(readFileSync(path.join(stateDir, files[0] as string), 'utf8').trim()).toBe(
      String(Math.floor(Date.now() / 1000 / 30)),
    );
  });
});
