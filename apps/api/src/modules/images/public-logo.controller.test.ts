// Unit test of PublicLogoController (R6Q20): the route is @Public and read-only (one GET, no other handler), it never
// reads the request context, a refusal sets no header, and the logo answers with the public cache headers.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/public-logo.controller.test.ts (from apps/api)
import 'reflect-metadata';

import { PassThrough, Readable } from 'node:stream';

import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../../platform/auth/public.decorator';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import type { DocumentsService } from '../../platform/documents/documents.service';
import { PUBLIC_LOGO_CACHE_CONTROL, PublicLogoController } from './public-logo.controller';

const proto = PublicLogoController.prototype;
const TENANT = '11111111-1111-4111-8111-111111111111';

function fakeResponse() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const res = Object.assign(sink, {
    statusCode: 200,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(h: Record<string, string>) {
      Object.assign(res.headers, h);
      return res;
    },
  });
  return { res, body: () => Buffer.concat(chunks) };
}

describe('PublicLogoController', () => {
  it('is one public GET at /v1/public/logo/:tenantId and nothing else', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicLogoController)).toBe('v1/public/logo');
    expect(Reflect.getMetadata(PATH_METADATA, proto.open)).toBe(':tenantId');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.open)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.open)).toBe(true);
    expect(Reflect.getMetadata(CAN_KEY, proto.open)).toBeUndefined();
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, proto.open)).toBeUndefined();
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers).toEqual(['open']);
  });

  it('streams the bytes with the type, a short public cache, nosniff and a locked-down CSP', async () => {
    const openPublicLogo = vi.fn().mockResolvedValue({
      notModified: false,
      stream: Readable.from([Buffer.from('png')]),
      mime: 'image/png',
      size: 3,
      etag: 'v1',
    });
    const { res, body } = fakeResponse();
    await new PublicLogoController({ openPublicLogo } as unknown as DocumentsService).open(
      TENANT,
      { headers: { 'if-none-match': '"old"' } } as unknown as Request,
      res as unknown as Response,
    );
    expect(openPublicLogo).toHaveBeenCalledWith(TENANT, '"old"');
    expect(res.statusCode).toBe(200);
    expect(body().toString()).toBe('png');
    expect(res.headers).toMatchObject({
      ETag: '"v1"',
      'Cache-Control': PUBLIC_LOGO_CACHE_CONTROL,
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    // The cache is public so a CDN or mail proxy may keep it, never `immutable`: a removed logo must go away.
    expect(PUBLIC_LOGO_CACHE_CONTROL).not.toMatch(/immutable|private/);
  });

  it('a refusal propagates and sets no header', async () => {
    const { res } = fakeResponse();
    const docs = {
      openPublicLogo: vi.fn().mockRejectedValue(new NotFoundException('Image not found')),
    };
    await expect(
      new PublicLogoController(docs as unknown as DocumentsService).open(
        TENANT,
        { headers: {} } as unknown as Request,
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.headers).toEqual({});
  });
});
