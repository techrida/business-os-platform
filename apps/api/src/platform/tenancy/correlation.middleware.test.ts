import { describe, expect, it, vi } from 'vitest';

import { CorrelationMiddleware, type CorrelatedRequest } from './correlation.middleware';
import { bindIdentity, ctx, currentCorrelationId } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs the middleware once and reports what it set and what the next handler could see. */
function run(headers: Record<string, string | string[]>, ip?: string) {
  const req = { headers, ip } as unknown as CorrelatedRequest;
  const responseHeaders: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  };
  let seenInside: string | undefined;
  let seenClient: { ip: string | null; userAgent: string | null } | undefined;
  const next = vi.fn(() => {
    seenInside = currentCorrelationId();
    // Binding an identity is how downstream code reads the client fields through ctx().
    bindIdentity({
      tenantId: 't',
      organizationId: 'o',
      orgKind: 'staff',
      userId: 'u',
      roles: [],
      tokenExp: 1,
    });
    seenClient = { ip: ctx().ip, userAgent: ctx().userAgent };
  });
  new CorrelationMiddleware().use(req, res as never, next);
  return { req, responseHeaders, seenInside, seenClient, next };
}

describe('CorrelationMiddleware', () => {
  it('keeps a valid incoming x-request-id and echoes it', () => {
    const { req, responseHeaders, seenInside, next } = run({ 'x-request-id': 'abc-12345-XYZ' });

    expect(req.correlationId).toBe('abc-12345-XYZ');
    expect(responseHeaders['x-request-id']).toBe('abc-12345-XYZ');
    expect(seenInside).toBe('abc-12345-XYZ');
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['has a forbidden character', 'abcdefgh\nINFO forged log line'],
    ['has a space', 'abcd efgh1234'],
  ])('replaces an invalid id (%s) with a fresh UUID', (_why, bad) => {
    const { req, responseHeaders, seenInside } = run({ 'x-request-id': bad });

    expect(req.correlationId).toMatch(UUID);
    expect(req.correlationId).not.toBe(bad);
    expect(responseHeaders['x-request-id']).toBe(req.correlationId);
    expect(seenInside).toBe(req.correlationId);
  });

  it('generates an id when the header is missing', () => {
    const { req, responseHeaders } = run({});

    expect(req.correlationId).toMatch(UUID);
    expect(responseHeaders['x-request-id']).toBe(req.correlationId);
  });

  it('treats a repeated header as invalid instead of picking one value', () => {
    const { req } = run({ 'x-request-id': ['abcdefgh-1', 'abcdefgh-2'] });

    expect(req.correlationId).toMatch(UUID);
  });

  it('does not leak the store outside the request', () => {
    run({ 'x-request-id': 'abc-12345-XYZ' });

    expect(currentCorrelationId()).toBeUndefined();
  });

  it('puts req.ip and the user-agent header in the store, readable through ctx()', () => {
    const { seenClient } = run({ 'user-agent': 'Mozilla/5.0 test' }, '203.0.113.7');

    expect(seenClient).toEqual({ ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test' });
  });

  it('uses null for a missing or empty ip and user-agent', () => {
    expect(run({}).seenClient).toEqual({ ip: null, userAgent: null });
    expect(run({ 'user-agent': '' }, '').seenClient).toEqual({ ip: null, userAgent: null });
  });

  it('truncates ip and user-agent to 512 characters', () => {
    const { seenClient } = run({ 'user-agent': 'u'.repeat(600) }, 'i'.repeat(600));

    expect(seenClient?.userAgent).toBe('u'.repeat(512));
    expect(seenClient?.ip).toBe('i'.repeat(512));
  });

  it('keeps a value of exactly 512 characters whole', () => {
    const { seenClient } = run({ 'user-agent': 'u'.repeat(512) });

    expect(seenClient?.userAgent).toHaveLength(512);
  });
});
