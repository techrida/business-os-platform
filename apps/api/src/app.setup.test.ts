import 'reflect-metadata';

import type { Server } from 'node:http';

import { ErrorBodySchema } from '@bos/contracts';
import { Body, Controller, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { configureApp } from './app.setup';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: { text?: string }): { length: number } {
    return { length: body.text?.length ?? 0 };
  }
}

describe('configureApp', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function start(): Promise<Server> {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app.getHttpServer() as Server;
  }

  it('accepts a JSON body under 16kb', async () => {
    const res = await request(await start())
      .post('/echo')
      .send({ text: 'a'.repeat(8_000) })
      .expect(201);
    expect(res.body).toEqual({ length: 8_000 });
  });

  it('rejects a JSON body over 16kb with 413 in the ErrorBody shape, reusing a valid x-request-id', async () => {
    const res = await request(await start())
      .post('/echo')
      .set('x-request-id', 'client-req-12345')
      .send({ text: 'a'.repeat(20_000) })
      .expect(413);
    expect(ErrorBodySchema.parse(res.body).error).toMatchObject({
      code: 'payload_too_large',
      correlationId: 'client-req-12345',
    });
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it('generates a correlation id when the header is missing or invalid', async () => {
    const res = await request(await start())
      .post('/echo')
      .set('x-request-id', 'bad id!')
      .send({ text: 'a'.repeat(20_000) })
      .expect(413);
    expect(ErrorBodySchema.parse(res.body).error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers malformed JSON with 400 bad_request in the ErrorBody shape', async () => {
    const res = await request(await start())
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"text": ')
      .expect(400);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('bad_request');
  });

  it('rejects an urlencoded body over 16kb with 413', async () => {
    await request(await start())
      .post('/echo')
      .type('form')
      .send(`text=${'a'.repeat(20_000)}`)
      .expect(413);
  });

  it('sets no global prefix and hides x-powered-by', async () => {
    const res = await request(await start())
      .post('/echo')
      .send({ text: 'x' })
      .expect(201);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
