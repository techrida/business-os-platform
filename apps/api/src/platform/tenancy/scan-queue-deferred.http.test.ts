// A deferred scan (bytes kept, only the scan queue was down) is a 202 with the quarantined version on EVERY upload route, through
// the real HTTP layer: Nest resets a status a handler sets, so the global error filter sends it (FU11).
import 'reflect-metadata';

import type { DocumentVersionDto } from '@bos/contracts';
import { Controller, Post, Put, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScanQueueDeferredError } from '../documents/scan-queue-deferred.error';
import { ErrorBodyFilter } from './error-body.filter';

const version = {
  id: 'v1',
  status: 'quarantined',
  filename: 'proof.pdf',
} as unknown as DocumentVersionDto;

@Controller('probe')
class ProbeController {
  /** A record-specific upload route that hands the receive's error straight up, as the portal proof routes do. */
  @Put('proof')
  put(): never {
    throw new ScanQueueDeferredError(version);
  }

  @Post('inbox')
  post(): never {
    throw new ScanQueueDeferredError(version);
  }
}

describe('ScanQueueDeferredError over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new ErrorBodyFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['PUT', '/probe/proof'],
    ['POST', '/probe/inbox'],
  ])('answers 202 with the quarantined version on %s %s', async (method, path) => {
    const res = await (method === 'PUT' ? request(baseUrl).put(path) : request(baseUrl).post(path));
    expect(res.status).toBe(202);
    expect(res.body).toEqual(version);
  });
});
