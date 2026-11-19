import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_NUMBER_SYSTEMS } from '@bos/locale';

import { ApiError } from './api';
import {
  getDateFormat,
  getNumberSystems,
  loadDisplaySettings,
  loadNumberSystems,
} from './display-settings';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: api.apiFetch,
}));
const sessions = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('./session', () => ({ getSession: sessions.getSession }));

const session = { roles: ['sales'] } as Session;

beforeEach(() => vi.clearAllMocks());

describe('loadNumberSystems', () => {
  it('reads the per-currency map from the display settings', async () => {
    const map = { NPR: 'international', INR: 'south_asian', USD: 'south_asian' };
    api.apiFetch.mockResolvedValue(
      Response.json({ numberSystems: map, dateFormat: 'dd MMM yyyy' }),
    );
    expect(await loadNumberSystems(session)).toEqual(map);
    expect(api.apiFetch).toHaveBeenCalledWith(session, '/v1/settings/display', undefined);
  });

  it('falls back to the default grouping when the API fails', async () => {
    api.apiFetch.mockResolvedValue(Response.json({ error: 'boom' }, { status: 500 }));
    expect(await loadNumberSystems(session)).toEqual(DEFAULT_NUMBER_SYSTEMS);
    api.apiFetch.mockRejectedValue(new ApiError(503, 'unavailable', null));
    expect(await loadNumberSystems(session)).toEqual(DEFAULT_NUMBER_SYSTEMS);
    api.apiFetch.mockRejectedValue(new Error('network down'));
    expect(await loadNumberSystems(session)).toEqual(DEFAULT_NUMBER_SYSTEMS);
  });

  it('falls back when the answer is not a known number system', async () => {
    api.apiFetch.mockResolvedValue(
      Response.json({ numberSystems: { NPR: 'martian' }, dateFormat: 'dd MMM yyyy' }),
    );
    expect(await loadNumberSystems(session)).toEqual(DEFAULT_NUMBER_SYSTEMS);
    api.apiFetch.mockResolvedValue(Response.json({}));
    expect(await loadNumberSystems(session)).toEqual(DEFAULT_NUMBER_SYSTEMS);
  });

  it('falls back without a session and does not call the API', async () => {
    expect(await loadNumberSystems(null)).toEqual(DEFAULT_NUMBER_SYSTEMS);
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

describe('getNumberSystems', () => {
  it('uses the current session', async () => {
    sessions.getSession.mockResolvedValue(session);
    const map = { NPR: 'international', INR: 'international', USD: 'international' };
    api.apiFetch.mockResolvedValue(
      Response.json({ numberSystems: map, dateFormat: 'dd MMM yyyy' }),
    );
    expect(await getNumberSystems()).toEqual(map);
  });

  it('never throws, even when the session lookup does', async () => {
    sessions.getSession.mockRejectedValue(new Error('valkey down'));
    expect(await getNumberSystems()).toEqual(DEFAULT_NUMBER_SYSTEMS);
  });
});

describe('loadDisplaySettings', () => {
  it('returns the number systems and the date format from one read', async () => {
    const map = { NPR: 'international', INR: 'south_asian', USD: 'international' };
    api.apiFetch.mockImplementation(() =>
      Response.json({ numberSystems: map, dateFormat: 'dd/MM/yyyy' }),
    );
    expect(await loadDisplaySettings(session)).toEqual({
      numberSystems: map,
      dateFormat: 'dd/MM/yyyy',
    });
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to both defaults on a failed or malformed read', async () => {
    const fallback = { numberSystems: DEFAULT_NUMBER_SYSTEMS, dateFormat: 'dd MMM yyyy' };
    api.apiFetch.mockImplementation(() =>
      Response.json({ numberSystems: DEFAULT_NUMBER_SYSTEMS, dateFormat: 'yyyy/dd/MM' }),
    );
    expect(await loadDisplaySettings(session)).toEqual(fallback);
    api.apiFetch.mockRejectedValue(new Error('network down'));
    expect(await loadDisplaySettings(session)).toEqual(fallback);
    expect(await loadDisplaySettings(null)).toEqual(fallback);
  });
});

describe('getDateFormat', () => {
  it("reads the tenant's date pattern with the current session", async () => {
    sessions.getSession.mockResolvedValue(session);
    api.apiFetch.mockImplementation(() =>
      Response.json({ numberSystems: DEFAULT_NUMBER_SYSTEMS, dateFormat: 'MMM dd, yyyy' }),
    );
    expect(await getDateFormat()).toBe('MMM dd, yyyy');
  });

  it('never throws: the default pattern when the read or the session fails', async () => {
    sessions.getSession.mockResolvedValue(session);
    api.apiFetch.mockImplementation(() => Response.json({ error: 'boom' }, { status: 500 }));
    expect(await getDateFormat()).toBe('dd MMM yyyy');
    sessions.getSession.mockRejectedValue(new Error('valkey down'));
    expect(await getDateFormat()).toBe('dd MMM yyyy');
  });
});
