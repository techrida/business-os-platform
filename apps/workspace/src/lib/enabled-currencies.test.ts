import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { currencyChoices, normalizeEnabled } from './enabled-currencies';
import { loadEnabledCurrencies } from './enabled-currencies.server';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: api.apiFetch,
}));

const session = { roles: ['sales'] } as Session;
const display = { numberSystems: {}, dateFormat: 'dd MMM yyyy' };

beforeEach(() => vi.clearAllMocks());

describe('currencyChoices', () => {
  it('offers the enabled currencies NPR first, in the fixed order', () => {
    expect(currencyChoices(['USD', 'NPR']).map((c) => c.value)).toEqual(['NPR', 'USD']);
    expect(currencyChoices(['USD', 'INR', 'NPR'])).toEqual([
      { value: 'NPR', label: 'NPR (Nepalese rupee)', enabled: true },
      { value: 'INR', label: 'INR (Indian rupee)', enabled: true },
      { value: 'USD', label: 'USD (US dollar)', enabled: true },
    ]);
  });

  it('always offers NPR, even when the list leaves it out', () => {
    expect(currencyChoices(['USD']).map((c) => c.value)).toEqual(['NPR', 'USD']);
  });

  it('keeps a document’s own currency that was switched off, with a plain label', () => {
    expect(currencyChoices(['NPR'], 'USD')).toEqual([
      { value: 'NPR', label: 'NPR (Nepalese rupee)', enabled: true },
      { value: 'USD', label: 'USD (US dollar)', enabled: false },
    ]);
    expect(currencyChoices(['NPR', 'USD'], 'USD').map((c) => c.enabled)).toEqual([true, true]);
    expect(currencyChoices(['NPR'], 'NPR')).toHaveLength(1);
  });

  it('falls back to the default list when nothing usable is given', () => {
    for (const empty of [null, undefined, [], ['EUR', 7]]) {
      expect(currencyChoices(empty).map((c) => c.value)).toEqual(['NPR', 'INR', 'USD']);
    }
    expect(normalizeEnabled(['USD', 'USD', 'NPR'])).toEqual(['NPR', 'USD']);
  });
});

describe('loadEnabledCurrencies', () => {
  it('reads the list from the display settings, which any staff user may call', async () => {
    api.apiFetch.mockResolvedValue(
      Response.json({ ...display, enabledCurrencies: ['USD', 'NPR'] }),
    );
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'USD']);
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
    expect(api.apiFetch).toHaveBeenCalledWith(session, '/v1/settings/display', undefined);
  });

  it('adds NPR when the saved list somehow lacks it', async () => {
    api.apiFetch.mockResolvedValue(Response.json({ ...display, enabledCurrencies: ['INR'] }));
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'INR']);
  });

  it('gives the default list when the field is missing, the read fails or there is no session', async () => {
    api.apiFetch.mockResolvedValue(Response.json(display));
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'INR', 'USD']);
    api.apiFetch.mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 }));
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'INR', 'USD']);
    api.apiFetch.mockResolvedValue(Response.json({ ...display, enabledCurrencies: ['EUR'] }));
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'INR', 'USD']);
    api.apiFetch.mockRejectedValue(new ApiError(503, 'unavailable', null));
    expect(await loadEnabledCurrencies(session)).toEqual(['NPR', 'INR', 'USD']);
    api.apiFetch.mockClear();
    expect(await loadEnabledCurrencies(null)).toEqual(['NPR', 'INR', 'USD']);
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});
