import { describe, expect, it, vi } from 'vitest';

import { CorrelationMiddleware, type CorrelatedRequest } from './correlation.middleware';
import { currentCorrelationId } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs the middleware once and reports what it set and what the next handler could see. */
function run(headers: Record<string, string | string[]>) {
  const req = { headers } as unknown as CorrelatedRequest;
  const responseHeaders: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  };
  let seenInside: string | undefined;
  const next = vi.fn(() => {
    seenInside = currentCorrelationId();
  });
  new CorrelationMiddleware().use(req, res as never, next);
  return { req, responseHeaders, seenInside, next };
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
});
