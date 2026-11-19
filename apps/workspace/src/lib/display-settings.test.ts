import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { getNumberSystem, loadNumberSystem } from './display-settings';
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

describe('loadNumberSystem', () => {
  it.each(['south_asian', 'international'] as const)(
    'reads %s from the display settings',
    async (system) => {
      api.apiFetch.mockResolvedValue(Response.json({ numberSystem: system }));
      expect(await loadNumberSystem(session)).toBe(system);
      expect(api.apiFetch).toHaveBeenCalledWith(session, '/v1/settings/display', undefined);
    },
  );

  it('falls back to the default grouping when the API fails', async () => {
    api.apiFetch.mockResolvedValue(Response.json({ error: 'boom' }, { status: 500 }));
    expect(await loadNumberSystem(session)).toBe('south_asian');
    api.apiFetch.mockRejectedValue(new ApiError(503, 'unavailable', null));
    expect(await loadNumberSystem(session)).toBe('south_asian');
    api.apiFetch.mockRejectedValue(new Error('network down'));
    expect(await loadNumberSystem(session)).toBe('south_asian');
  });

  it('falls back when the answer is not a known number system', async () => {
    api.apiFetch.mockResolvedValue(Response.json({ numberSystem: 'martian' }));
    expect(await loadNumberSystem(session)).toBe('south_asian');
    api.apiFetch.mockResolvedValue(Response.json({}));
    expect(await loadNumberSystem(session)).toBe('south_asian');
  });

  it('falls back without a session and does not call the API', async () => {
    expect(await loadNumberSystem(null)).toBe('south_asian');
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

describe('getNumberSystem', () => {
  it('uses the current session', async () => {
    sessions.getSession.mockResolvedValue(session);
    api.apiFetch.mockResolvedValue(Response.json({ numberSystem: 'international' }));
    expect(await getNumberSystem()).toBe('international');
  });

  it('never throws, even when the session lookup does', async () => {
    sessions.getSession.mockRejectedValue(new Error('valkey down'));
    expect(await getNumberSystem()).toBe('south_asian');
  });
});
