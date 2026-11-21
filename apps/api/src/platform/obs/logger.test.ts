import { createServer, type IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp, type Options as PinoHttpOptions } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { CoreConfig } from '../config/config';
import { buildLoggerParams, serializeLoggedRequest } from './logger';

type ExpressLikeRequest = IncomingMessage & {
  originalUrl?: string;
  query?: Record<string, string>;
};

/** Logs one request through the real pino-http settings, shaped like an Express request. */
async function logOneRequest(path: string): Promise<string> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const params = buildLoggerParams({ LOG_LEVEL: 'info' } as unknown as CoreConfig, 'api');
  const log = pinoHttp(params.pinoHttp as PinoHttpOptions, sink);
  const server = createServer((req: ExpressLikeRequest, res) => {
    // Express sets both before nestjs-pino's middleware runs; the std serializer copies them.
    const url = new URL(req.url ?? '/', 'http://localhost');
    req.originalUrl = req.url ?? '';
    req.query = Object.fromEntries(url.searchParams);
    log(req, res);
    res.end('ok');
  });
  await request(server).get(path);
  return lines.join('');
}

describe('request url in logs', () => {
  it('drops the query string and parsed query of the lead duplicates lookup', async () => {
    const out = await logOneRequest(
      '/v1/leads/duplicates?email=ram%40example.com&phone=9800000000&name=Ram%20Thapa&company=Acme',
    );
    expect(out).toContain('"url":"/v1/leads/duplicates"');
    expect(out).not.toContain('ram%40example.com');
    expect(out).not.toContain('ram@example.com');
    expect(out).not.toContain('9800000000');
    expect(out).not.toContain('Ram Thapa');
    expect(out).not.toContain('Acme');
  });

  // Express routes case-insensitively and accepts a trailing slash, so these spellings reach the same handler.
  it.each([
    '/V1/Leads/Duplicates?email=ram%40example.com&phone=9800000000',
    '/v1/leads/duplicates/?email=ram%40example.com&phone=9800000000',
    '/V1/LEADS/DUPLICATES/?email=ram%40example.com&phone=9800000000',
  ])('drops the query of the lookup spelled %s', async (path) => {
    const out = await logOneRequest(path);
    expect(out).toContain(`"url":"${path.slice(0, path.indexOf('?'))}"`);
    expect(out).not.toContain('ram%40example.com');
    expect(out).not.toContain('ram@example.com');
    expect(out).not.toContain('9800000000');
  });

  it('cuts the query of the mixed-case lookup in the serializer', () => {
    const req = { url: '/V1/Leads/Duplicates?email=x', query: { email: 'x' } };
    expect(serializeLoggedRequest(req)).toEqual({ url: '/V1/Leads/Duplicates' });
  });

  it('keeps the query string and parsed query on every other route', async () => {
    const out = await logOneRequest('/v1/leads?q=x');
    expect(out).toContain('"url":"/v1/leads?q=x"');
    expect(out).toContain('"query":{"q":"x"}');
  });

  it('returns the serialized request untouched for other routes', () => {
    const req = { url: '/v1/leads?q=x', query: { q: 'x' } };
    expect(serializeLoggedRequest(req)).toBe(req);
    expect(req).toEqual({ url: '/v1/leads?q=x', query: { q: 'x' } });
  });
});
