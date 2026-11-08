import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { findUnmarkedRoutes } from '../authz/route-policy.check';
import { AppConfig } from '../config/config';
import { BounceController, SIGNATURE_HEADER } from './bounce.controller';
import {
  BounceService,
  BounceStore,
  type BounceMark,
  verifyPostalSignature,
} from './bounce.service';

const SECRET = 'postal-test-webhook-secret-32-chars!';

class FakeBounceStore extends BounceStore {
  marks: BounceMark[] = [];
  /** Message ids this fake "knows", as the outbox would after a send. */
  known = new Set(['abc123@mail.example.com']);

  markBounced(mark: BounceMark): Promise<number> {
    this.marks.push(mark);
    return Promise.resolve(this.known.has(mark.messageId) ? 1 : 0);
  }
}

const sign = (rawBody: Buffer, secret = SECRET): string =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

function request(payload: unknown, header?: string | null, secret = SECRET) {
  const rawBody = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const headers: Record<string, string> = {};
  if (header !== null) headers[SIGNATURE_HEADER] = header ?? sign(rawBody, secret);
  return { headers, rawBody };
}
type Req = Parameters<BounceController['postal']>[0];

const bounced = (over: Record<string, unknown> = {}) => ({
  event: 'MessageBounced',
  uuid: 'evt-1',
  payload: {
    original_message: {
      id: 41,
      message_id: 'abc123@mail.example.com',
      to: 'someone@customer.example',
      subject: 'Quotation QT-1 is ready for you',
    },
    bounce: {
      id: 42,
      message_id: 'bounce-1@postal.example',
      from: 'mailer-daemon@customer.example',
    },
  },
  ...over,
});

const deliveryFailed = (status: string) => ({
  event: 'MessageDeliveryFailed',
  uuid: 'evt-2',
  payload: {
    message: { id: 43, message_id: '<abc123@mail.example.com>', to: 'someone@customer.example' },
    status,
    details: '550 5.1.1 someone@customer.example does not exist',
    output: 'smtp said no for someone@customer.example',
  },
});

let store: FakeBounceStore;
const controller = (secret: string | null = SECRET) =>
  new BounceController(
    { POSTAL_WEBHOOK_SECRET: secret ?? undefined } as unknown as AppConfig,
    new BounceService(store),
  );
const call = (c: BounceController, req: ReturnType<typeof request>) =>
  c.postal(req as unknown as Req);

beforeEach(() => {
  store = new FakeBounceStore();
});

describe('POST /v1/hooks/postal: signature (deny by default)', () => {
  it('refuses every call when no secret is configured, even one signed with an empty or guessed key', async () => {
    for (const secret of [null, '']) {
      for (const signingKey of ['', 'guess', SECRET]) {
        await expect(
          call(controller(secret), request(bounced(), undefined, signingKey)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
    }
    expect(store.marks).toEqual([]);
  });

  it.each([
    ['no header', () => null],
    ['an empty header', () => ''],
    [
      'a header signed with another key',
      () => sign(Buffer.from(JSON.stringify(bounced())), 'other'),
    ],
    ['a short digest', () => 'ab'.repeat(8)],
    ['a non-hex digest of the right length', () => 'z'.repeat(64)],
    ['a digest of another body', () => sign(Buffer.from('{}'))],
  ])('401s with %s and records nothing', async (_name, header) => {
    await expect(call(controller(), request(bounced(), header()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.marks).toEqual([]);
  });

  it('401s when the raw body is missing', async () => {
    const req = { headers: { [SIGNATURE_HEADER]: sign(Buffer.from('{}')) }, rawBody: undefined };
    await expect(controller().postal(req as unknown as Req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts the digest with or without a sha256= prefix and in upper case', async () => {
    const body = Buffer.from(JSON.stringify(bounced()));
    const digest = sign(body);
    for (const header of [digest, `sha256=${digest}`, digest.toUpperCase()]) {
      store.marks = [];
      await call(controller(), { headers: { [SIGNATURE_HEADER]: header }, rawBody: body });
      expect(store.marks).toHaveLength(1);
    }
  });

  it('verifyPostalSignature never throws on odd input', () => {
    const body = Buffer.from('x');
    expect(verifyPostalSignature(body, '', SECRET)).toBe(false);
    expect(verifyPostalSignature(body, sign(body), '')).toBe(false);
    expect(verifyPostalSignature(body, 'sha256=', SECRET)).toBe(false);
    expect(verifyPostalSignature(body, '\u0000ÿ', SECRET)).toBe(false);
    expect(verifyPostalSignature(body, sign(body), SECRET)).toBe(true);
  });
});

describe('POST /v1/hooks/postal: events', () => {
  it('marks a bounce hard and looks the message up by its id only, never by the payload address', async () => {
    await call(controller(), request(bounced()));
    expect(store.marks).toEqual([{ messageId: 'abc123@mail.example.com', kind: 'hard' }]);
    // The store gets an id and a kind: nothing from the payload that a caller could point at another tenant.
    expect(JSON.stringify(store.marks)).not.toContain('customer.example');
  });

  it('treats a HardFail delivery as hard and strips the angle brackets of the message id', async () => {
    await call(controller(), request(deliveryFailed('HardFail')));
    expect(store.marks).toEqual([{ messageId: 'abc123@mail.example.com', kind: 'hard' }]);
  });

  it('treats a SoftFail delivery as soft', async () => {
    await call(controller(), request(deliveryFailed('SoftFail')));
    expect(store.marks).toEqual([{ messageId: 'abc123@mail.example.com', kind: 'soft' }]);
  });

  it('answers quietly for events it does not act on, and for a message it never sent', async () => {
    await expect(
      call(
        controller(),
        request({ event: 'MessageSent', payload: { message: { message_id: 'x' } } }),
      ),
    ).resolves.toBeUndefined();
    expect(store.marks).toEqual([]);

    await expect(
      call(
        controller(),
        request(bounced({ payload: { original_message: { message_id: 'unknown@elsewhere' } } })),
      ),
    ).resolves.toBeUndefined();
  });

  it('answers 204 (not an error) for an authentic bounce that carries no message id', async () => {
    await expect(
      call(controller(), request({ event: 'MessageBounced', payload: {} })),
    ).resolves.toBeUndefined();
    expect(store.marks).toEqual([]);
  });

  it('400s on a signed body that is not JSON, or has no event name', async () => {
    await expect(call(controller(), request('not json'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(call(controller(), request({ payload: {} }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(call(controller(), request([1, 2]))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a store failure surface, so Postal retries the call', async () => {
    store.markBounced = () => Promise.reject(new Error('db down'));
    await expect(call(controller(), request(bounced()))).rejects.toThrow('db down');
  });
});

describe('POST /v1/hooks/postal: route policy', () => {
  it('is marked @Public, which is the only way a route skips login', () => {
    const handler = BounceController.prototype.postal;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
  });

  it('passes the boot-time route-policy sweep', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BounceController],
      providers: [
        { provide: BounceService, useValue: new BounceService(store) },
        { provide: AppConfig, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(findUnmarkedRoutes(app)).toEqual([]);
    await app.close();
  });
});
