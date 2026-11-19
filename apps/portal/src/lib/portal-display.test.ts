import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOf, json, session, stubPortalEnv } from './billing-test-support';
import { DEFAULT_PORTAL_DISPLAY } from './display';

vi.mock('server-only', () => ({}));

const { getPortalDisplay } = await import('./portal-display');

const fetchMock = vi.fn<typeof fetch>();

/** A fresh token per call, so a per-request cache cannot answer for an earlier one. */
const other = (n: number) => ({ accessToken: `token-${n}` });

const company = {
  numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
  dateFormat: 'dd/MM/yyyy',
} as const;

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getPortalDisplay', () => {
  it("reads the company's setting from GET /v1/portal/display as the session's user", async () => {
    fetchMock.mockResolvedValue(json(company));
    await expect(getPortalDisplay(session)).resolves.toEqual(company);
    const call = callOf(fetchMock);
    expect(call.url).toBe('http://api:3001/v1/portal/display');
    expect(call.init.method).toBe('GET');
    expect(call.headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });

  it('falls back to the defaults, and never throws, when the API fails or answers oddly', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'forbidden' } }, 403));
    await expect(getPortalDisplay(other(1))).resolves.toEqual(DEFAULT_PORTAL_DISPLAY);
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    await expect(getPortalDisplay(other(2))).resolves.toEqual(DEFAULT_PORTAL_DISPLAY);
    fetchMock.mockResolvedValue(json({ numberSystems: 'lakh' }));
    await expect(getPortalDisplay(other(3))).resolves.toEqual(DEFAULT_PORTAL_DISPLAY);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(getPortalDisplay(other(4))).resolves.toEqual(DEFAULT_PORTAL_DISPLAY);
  });
});
