// Unit test of ImagesController (U12, D33): the route policy (any signed-in principal at the route; staff is checked
// in the service), the image headers (inline, nosniff, private no-cache so every use revalidates, quoted ETag) and
// body, a 304 with no body and no content headers but the same no-cache, a refusal that sets no header, and the caller
// (scope, actor, principal) handed to the service from the request context; the one-request POST upload (declared 200, the three headers and the request
// stream handed through, refusals propagated). Fake ImagesService and response; the real request store.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/images.controller.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import {
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  RequestMethod,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import type { Principal } from '../../platform/authz/principal';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { IMAGE_CACHE_CONTROL, ImagesController } from './images.controller';
import type { ImageUploadRequest, ImagesService } from './images.service';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const me: Principal = {
  userId: USER,
  zitadelUserId: `z-${USER}`,
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: randomUUID(),
  roles: ['sales'],
  departmentId: null,
  status: 'active',
  grants: new Map(),
};

/** Runs `fn` as an HTTP request of `me`, as the tenancy interceptor binds it. */
function asMe<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('ctl-corr', () => {
    bindIdentity({
      tenantId: TENANT,
      organizationId: ORG,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: me.idpOrgId,
      userId: me.zitadelUserId,
      roles: me.roles,
      departmentId: null,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(me);
    return fn();
  });
}

/** An Express-like response that is a real writable stream, recording status and headers. */
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

const request = (ifNoneMatch?: string) =>
  ({
    headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch },
  }) as unknown as Request;

const images = { open: vi.fn(), set: vi.fn(), upload: vi.fn() };
const controller = new ImagesController(images as unknown as ImagesService);

beforeEach(() => {
  images.open.mockReset();
  images.set.mockReset();
  images.upload.mockReset();
});

describe('route policy', () => {
  it('is @AnyAuthenticated on the controller with no @Can, at v1/images', () => {
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ImagesController)).toBe(true);
    expect(Reflect.getMetadata(CAN_KEY, ImagesController)).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, ImagesController)).toBe('v1/images');
  });

  it('declares GET :documentId and PUT :ownerType/:ownerId', () => {
    const open = Object.getOwnPropertyDescriptor(ImagesController.prototype, 'open')
      ?.value as object;
    const set = Object.getOwnPropertyDescriptor(ImagesController.prototype, 'set')?.value as object;
    expect(Reflect.getMetadata(METHOD_METADATA, open)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, open)).toBe(':documentId');
    expect(Reflect.getMetadata(METHOD_METADATA, set)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(PATH_METADATA, set)).toBe(':ownerType/:ownerId');
    for (const handler of [open, set])
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBeUndefined();
  });
});

describe('GET /v1/images/:documentId', () => {
  it('streams the bytes inline with its type, length, nosniff, a private must-revalidate cache and a quoted ETag', async () => {
    const versionId = randomUUID();
    images.open.mockResolvedValue({
      notModified: false,
      stream: Readable.from([PNG]),
      mime: 'image/png',
      size: PNG.length,
      etag: versionId,
    });
    const { res, body } = fakeResponse();
    const id = randomUUID();
    await asMe(() => controller.open(id, request(), res as unknown as Response));

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      ETag: `"${versionId}"`,
      'Cache-Control': 'private, no-cache',
      'Content-Type': 'image/png',
      'Content-Length': String(PNG.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    // A max-age or `immutable` would let the browser reuse the picture after a switch or logout without asking.
    expect(IMAGE_CACHE_CONTROL).toBe('private, no-cache');
    expect(IMAGE_CACHE_CONTROL).not.toMatch(/max-age|immutable/);
    expect(body().equals(PNG)).toBe(true);
    expect(res.writableEnded).toBe(true);
  });

  it('answers 304 with only the ETag and Cache-Control and no body, passing If-None-Match on', async () => {
    const versionId = randomUUID();
    images.open.mockResolvedValue({ notModified: true, etag: versionId });
    const { res, body } = fakeResponse();
    const id = randomUUID();
    await asMe(() => controller.open(id, request(`W/"${versionId}"`), res as unknown as Response));

    expect(images.open.mock.calls[0]?.[1]).toBe(id);
    expect(images.open.mock.calls[0]?.[2]).toBe(`W/"${versionId}"`);
    expect(res.statusCode).toBe(304);
    expect(res.headers).toEqual({ ETag: `"${versionId}"`, 'Cache-Control': 'private, no-cache' });
    expect(body().length).toBe(0);
    expect(res.writableEnded).toBe(true);
  });

  it('lets a 404 through untouched: no header is set and nothing is written', async () => {
    images.open.mockRejectedValue(new NotFoundException('Image not found'));
    const { res } = fakeResponse();
    await expect(
      asMe(() => controller.open(randomUUID(), request(), res as unknown as Response)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.headers).toEqual({});
    expect(res.writableEnded).toBe(false);
  });

  it('hands the service the request scope, the user actor and the principal', async () => {
    images.open.mockResolvedValue({ notModified: true, etag: 'v' });
    const { res } = fakeResponse();
    await asMe(() => controller.open(randomUUID(), request(), res as unknown as Response));
    expect(images.open.mock.calls[0]?.[0]).toMatchObject({
      scope: { tenantId: TENANT, organizationId: ORG },
      actor: { kind: 'user', id: USER, correlationId: 'ctl-corr' },
      principal: me,
    });
  });
});

describe('PUT /v1/images/:ownerType/:ownerId', () => {
  it('passes the raw path params and body to the service and returns its answer', async () => {
    const documentId = randomUUID();
    images.set.mockResolvedValue({ documentId });
    const body = { documentId };
    await expect(
      asMe(() => controller.set('customer_logo', 'not-even-a-uuid', body)),
    ).resolves.toEqual({ documentId });
    const [who, ownerType, ownerId, passed] = (images.set.mock.calls[0] ?? []) as unknown[];
    expect(who).toMatchObject({ scope: { tenantId: TENANT, organizationId: ORG }, principal: me });
    expect([ownerType, ownerId, passed]).toEqual(['customer_logo', 'not-even-a-uuid', body]);
  });
});

describe('POST /v1/images/:ownerType/:ownerId', () => {
  const handler = () =>
    Object.getOwnPropertyDescriptor(ImagesController.prototype, 'upload')?.value as object;

  /** A request that is a real readable stream (the body) carrying `headers`, as Express hands it over. */
  const uploadRequest = (headers: Record<string, string | string[]>) =>
    Object.assign(Readable.from([PNG]), { headers }) as unknown as Request;

  it('is declared POST :ownerType/:ownerId with status 200 and no @Can', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler())).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler())).toBe(':ownerType/:ownerId');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler())).toBe(200);
    expect(Reflect.getMetadata(CAN_KEY, handler())).toBeUndefined();
  });

  it('hands the raw params, the three headers and the request stream itself to the service, with the caller', async () => {
    const documentId = randomUUID();
    images.upload.mockResolvedValue({ documentId });
    const req = uploadRequest({
      'content-type': 'image/png; charset=binary',
      'content-length': String(PNG.length),
      'x-file-name': 'my%20face.png',
    });
    await expect(
      asMe(() => controller.upload('user_avatar', 'not-even-a-uuid', req)),
    ).resolves.toEqual({ documentId });

    const [ownerType, ownerId, passed, who] = (images.upload.mock.calls[0] ?? []) as [
      string,
      string,
      ImageUploadRequest,
      unknown,
    ];
    expect([ownerType, ownerId]).toEqual(['user_avatar', 'not-even-a-uuid']);
    expect(passed).toEqual({
      contentType: 'image/png; charset=binary',
      contentLength: String(PNG.length),
      fileNameHeader: 'my%20face.png',
      stream: req,
    });
    // The stream is the request, unread: nothing in the controller buffered the body.
    expect(passed.stream).toBe(req);
    expect(passed.stream.readableEnded).toBe(false);
    expect(who).toMatchObject({
      scope: { tenantId: TENANT, organizationId: ORG },
      actor: { kind: 'user', id: USER, correlationId: 'ctl-corr' },
      principal: me,
    });
  });

  it('passes absent headers as undefined, and a (typed, never seen at runtime) header array as absent', async () => {
    images.upload.mockResolvedValue({ documentId: randomUUID() });
    await asMe(() =>
      controller.upload('entity_logo', ORG, uploadRequest({ 'x-file-name': ['a.png', 'b.png'] })),
    );
    const passed = images.upload.mock.calls[0]?.[2] as ImageUploadRequest;
    expect(passed.contentType).toBeUndefined();
    expect(passed.contentLength).toBeUndefined();
    expect(passed.fileNameHeader).toBeUndefined();
  });

  it('lets the service refusals through untouched', async () => {
    images.upload.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      asMe(() => controller.upload('user_avatar', randomUUID(), uploadRequest({}))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    images.upload.mockRejectedValueOnce(new PayloadTooLargeException());
    await expect(
      asMe(() => controller.upload('user_avatar', randomUUID(), uploadRequest({}))),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
