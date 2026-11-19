import { describe, expect, it } from 'vitest';

import { describeError } from './admin-errors';

const failure = (status: number, body?: unknown) =>
  Object.assign(new Error('boom'), { status, body });
const envelope = (message: string) => ({
  error: { code: 'bad_request', message, correlationId: 'req-12345678' },
});

describe('describeError', () => {
  it('names the action on a 403', () => {
    expect(describeError(failure(403), 'invite users')).toBe(
      "You don't have permission to invite users.",
    );
  });

  it('shows the API message on 400 and 409, and a fallback when there is none', () => {
    expect(describeError(failure(409, envelope('That key already exists')), 'create a group')).toBe(
      'That key already exists',
    );
    expect(describeError(failure(400, 'plain text'), 'create a group')).toContain('create a group');
  });

  it('keeps 503 distinct from 403 (the feature is off, the caller did nothing wrong)', () => {
    const message = describeError(
      failure(503, envelope('User administration is not configured')),
      'invite users',
    );
    expect(message).toBe('User administration is not configured');
    expect(message).not.toContain('permission');
  });

  it('asks for a new sign-in on 401 and gives a generic line for everything else', () => {
    expect(describeError(failure(401), 'x')).toMatch(/Sign in again/);
    expect(describeError(failure(502), 'x')).toMatch(/did not answer/);
    expect(describeError(new TypeError('fetch failed'), 'x')).toMatch(/did not answer/);
    expect(describeError('weird', 'x')).toMatch(/did not answer/);
  });
});
