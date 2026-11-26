import { createServer, type IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';

import { DrizzleQueryError } from 'drizzle-orm/errors';
import { pinoHttp, type Options as PinoHttpOptions } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { CoreConfig } from '../config/config';
import { buildLoggerParams, describeErrorForLog, serializeLoggedRequest } from './logger';

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

  it.each([
    ['/v1/customers?q=ram', '/v1/customers'],
    ['/v1/customers/?q=ram&page=2', '/v1/customers/'],
    ['/v1/quotations?customer=ram%40example.com', '/v1/quotations'],
  ])('logs %s as %s, without the query string or the parsed query', async (path, logged) => {
    const out = await logOneRequest(path);
    expect(out).toContain(`"url":"${logged}"`);
    expect(out).not.toContain('q=ram');
    expect(out).not.toContain('ram%40example.com');
    expect(out).not.toContain('"query"');
  });

  it('keeps a url that has no query as it is', async () => {
    expect(await logOneRequest('/v1/leads')).toContain('"url":"/v1/leads"');
  });

  it('cuts the query of the referer header too', () => {
    const req = {
      url: '/v1/leads',
      headers: { referer: 'https://app.example.com/leads?q=ram%40example.com', host: 'api' },
    };
    const original = req.headers;
    expect(serializeLoggedRequest(req).headers).toEqual({
      referer: 'https://app.example.com/leads',
      host: 'api',
    });
    // The request's own headers are not edited.
    expect(original.referer).toBe('https://app.example.com/leads?q=ram%40example.com');
  });
});

/** The root logger the app builds from the same settings, writing to an array. */
function buildLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const params = buildLoggerParams({ LOG_LEVEL: 'info' } as unknown as CoreConfig, 'worker');
  const log = pinoHttp(params.pinoHttp as PinoHttpOptions, sink);
  return { logger: log.logger, output: () => lines.join('') };
}

describe('database error values in logs', () => {
  const cause = new Error('duplicate key value violates unique constraint "customers_email_key"');
  const queryError = new DrizzleQueryError(
    'insert into customers (email, phone) values ($1, $2)',
    ['secret@example.com', '9800000000'],
    cause,
  );

  it('drops the params of a query error given as a message, as the worker log sites do', () => {
    const { logger, output } = buildLogger();
    logger.error(`could not render: ${queryError.message}`);
    logger.error(queryError.stack ?? '');
    expect(output()).toContain('insert into customers (email, phone) values ($1, $2)');
    expect(output()).not.toContain('secret@example.com');
    expect(output()).not.toContain('9800000000');
  });

  it('drops the params of a query error bound as err', () => {
    const { logger, output } = buildLogger();
    logger.error({ err: queryError }, 'job failed');
    expect(output()).toContain('insert into customers');
    expect(output()).not.toContain('secret@example.com');
  });

  it('describeErrorForLog keeps the query text and the cause stack, not the params', () => {
    const described = describeErrorForLog(queryError);
    expect(described.message).toBe(
      'Failed query: insert into customers (email, phone) values ($1, $2)',
    );
    expect(described.stack).toContain('customers_email_key');
    expect(JSON.stringify(described)).not.toContain('secret@example.com');
  });

  it('describeErrorForLog scrubs a plain error that quotes a query error message', () => {
    const wrapped = new Error(`outer: ${queryError.message}`);
    expect(JSON.stringify(describeErrorForLog(wrapped))).not.toContain('secret@example.com');
    expect(describeErrorForLog('plain')).toEqual({ message: 'plain', stack: undefined });
  });
});
