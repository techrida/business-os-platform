import 'reflect-metadata';

import { ErrorBodySchema } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
  type ArgumentsHost,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ErrorBodyFilter, codeForStatus } from './error-body.filter';
import { runWithRequestStore } from './request-context';

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

/** Runs the filter against fake Express objects and returns what it would have sent. */
function filter(
  exception: unknown,
  reqInit: { headers?: Record<string, string>; correlationId?: string } = {},
): Captured {
  const out: Captured = { headers: {} };
  const req = {
    method: 'GET',
    path: '/v1/thing',
    headers: reqInit.headers ?? {},
    correlationId: reqInit.correlationId,
  };
  const res = {
    headersSent: false,
    setHeader: (n: string, v: string) => {
      out.headers[n] = v;
    },
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ErrorBodyFilter().catch(exception, host);
  return out;
}

describe('ErrorBodyFilter', () => {
  let errorLog: MockInstance<Logger['error']>;
  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [new UnauthorizedException('no token'), 401, 'unauthenticated'],
    [new ForbiddenException('nope'), 403, 'forbidden'],
    [new NotFoundException('missing'), 404, 'not_found'],
    [new ConflictException('stale'), 409, 'conflict'],
    [new UnsupportedMediaTypeException('type'), 415, 'unsupported_media_type'],
    [new PayloadTooLargeException('big'), 413, 'payload_too_large'],
    [new BadRequestException('bad'), 400, 'bad_request'],
    [new ServiceUnavailableException('jwks down'), 503, 'unavailable'],
    [new InternalServerErrorException('boom'), 500, 'internal'],
    [new HttpException('teapot', 418), 418, 'bad_request'],
    [new Error('plain'), 500, 'internal'],
  ])('maps %s to %i %s with a body that parses as ErrorBodySchema', (exception, status, code) => {
    const out = filter(exception, { headers: { 'x-request-id': 'req-12345678' } });

    expect(out.status).toBe(status);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.correlationId).toBe('req-12345678');
  });

  it('exposes the message of a client error', () => {
    const out = filter(new ForbiddenException('Organization is not registered'));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Organization is not registered');
  });

  it('passes a known reason through on a 403 and keeps the code and message', () => {
    const out = filter(
      new ForbiddenException({
        code: 'forbidden',
        reason: 'separation_of_duties',
        message: 'You prepared this',
      }),
    );

    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'forbidden',
      message: 'You prepared this',
      reason: 'separation_of_duties',
    });
  });

  it('passes a known reason through on a 400: a malformed X-Entity-Id is invalid_entity', () => {
    const out = filter(
      new BadRequestException({
        code: 'bad_request',
        message: 'X-Entity-Id must be a uuid',
        reason: 'invalid_entity',
      }),
    );

    expect(out.status).toBe(400);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'bad_request',
      message: 'X-Entity-Id must be a uuid',
      reason: 'invalid_entity',
    });
  });

  it('drops an unknown reason, a reason on a plain 403, and a reason on any other status', () => {
    const unknown = filter(new ForbiddenException({ reason: 'because I said so' }));
    expect(ErrorBodySchema.parse(unknown.body).error).not.toHaveProperty('reason');
    expect(ErrorBodySchema.parse(unknown.body).error.message).toBe('Forbidden');

    const plain = filter(new ForbiddenException('nope'));
    expect(ErrorBodySchema.parse(plain.body).error).not.toHaveProperty('reason');

    const conflict = filter(new ConflictException({ reason: 'out_of_scope', message: 'stale' }));
    expect(ErrorBodySchema.parse(conflict.body).error).not.toHaveProperty('reason');
  });

  it('joins a validation message array', () => {
    const out = filter(new BadRequestException(['a is required', 'b must be a number']));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('a is required; b must be a number');
  });

  it('hides the detail of a 5xx and logs it with the correlation id and stack', () => {
    const secret = new Error('connection to postgres://bos_app:hunter2@db failed');
    const out = filter(secret, { correlationId: 'corr-abcdef12' });

    const serialized = JSON.stringify(out.body);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('postgres');
    expect(serialized).not.toContain('at '); // no stack frames
    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Internal server error');

    expect(errorLog).toHaveBeenCalledOnce();
    const [message, stack] = errorLog.mock.calls[0] as [string, string];
    expect(message).toContain('corr-abcdef12');
    expect(message).toContain('500');
    expect(stack).toContain('hunter2'); // the log keeps the detail, the response does not
  });

  it('hides the message of an explicit 500 HttpException too', () => {
    const out = filter(new InternalServerErrorException('internal detail'));

    expect(JSON.stringify(out.body)).not.toContain('internal detail');
  });

  it('keeps the 503 message (it is written by us) and logs it', () => {
    const out = filter(new ServiceUnavailableException('Identity provider unavailable'));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Identity provider unavailable');
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('does not log 4xx errors as errors', () => {
    filter(new UnauthorizedException());

    expect(errorLog).not.toHaveBeenCalled();
  });

  it('maps a plain Express error that carries a status (body-parser 413)', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413 });
    const out = filter(tooLarge);

    expect(out.status).toBe(413);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'payload_too_large',
      message: 'Payload too large',
    });
  });

  it('takes the correlation id from the request context first', () => {
    const out = runWithRequestStore('ctx-12345678', () =>
      filter(new UnauthorizedException(), { headers: { 'x-request-id': 'header-12345678' } }),
    );

    expect(ErrorBodySchema.parse(out.body).error.correlationId).toBe('ctx-12345678');
    expect(out.headers['x-request-id']).toBe('ctx-12345678');
  });

  it('falls back to a valid x-request-id header, else generates one, outside the context', () => {
    const fromHeader = filter(new UnauthorizedException(), {
      headers: { 'x-request-id': 'header-12345678' },
    });
    expect(ErrorBodySchema.parse(fromHeader.body).error.correlationId).toBe('header-12345678');

    const generated = filter(new UnauthorizedException(), {
      headers: { 'x-request-id': 'bad id' },
    });
    const id = ErrorBodySchema.parse(generated.body).error.correlationId;
    expect(id).not.toBe('bad id');
    expect(id.length).toBeGreaterThanOrEqual(8);
  });

  it('logs every 403 as one structured line with its reason, the route pattern and no user data', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      filter(
        new ForbiddenException({
          code: 'forbidden',
          reason: 'out_of_scope',
          message: 'You have no approval assignment',
        }),
        { correlationId: 'corr-403' },
      );
      filter(new NotFoundException('missing'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual({
        msg: 'request forbidden',
        event: 'http.forbidden',
        status: 403,
        method: 'GET',
        // The fake request has a path but no matched route: the path never reaches the line.
        route: 'unmatched',
        code: 'forbidden',
        reason: 'out_of_scope',
        correlationId: 'corr-403',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('codeForStatus covers the documented table', () => {
    expect([401, 403, 404, 409, 413, 415, 400, 503, 500, 502].map(codeForStatus)).toEqual([
      'unauthenticated',
      'forbidden',
      'not_found',
      'conflict',
      'payload_too_large',
      'unsupported_media_type',
      'bad_request',
      'unavailable',
      'internal',
      'internal',
    ]);
  });
});
