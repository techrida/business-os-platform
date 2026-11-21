// Unit tests for the thin HTTP layer and the SLA processor wiring: header and body validation (400s),
// route permissions, and the job names. The services are fakes; their rules are tested on Postgres in
// approvals.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException, Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startTestIssuer, type TestIssuer } from '../../../test/e2e/support/test-issuer';
import { JwtVerifier } from '../../platform/auth/jwt-verifier';

import type { AuthenticatedRequest } from '../../platform/auth/claims';
import { STEP_UP_REQUIRED, StepUpRequiredException } from '../../platform/auth/step-up';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import {
  AdminApprovalGroupsController,
  AdminDelegationsController,
  AdminWorkflowsController,
} from './admin-workflows.controller';
import { ApprovalsController } from './approvals.controller';
import {
  ApprovalsSlaProcessor,
  ApprovalsSlaScheduler,
  SLA_EVERY_MS,
  SLA_JOB,
} from './sla.processor';

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';

/**
 * A request at version 3 whose active step (seq 2) is resolved to `roleKey` ('' for a step with no
 * role: a group, a named user, or a department head who is in post).
 */
function requestAt(roleKey: string, kind: 'role' | 'group' | 'user' | 'department_head' = 'role') {
  return {
    requestId: ID,
    version: 3,
    currentSeq: 2,
    steps: [
      { seq: 1, kind: 'role', roleKey: 'finance', status: 'approved' },
      { seq: 2, kind, roleKey: roleKey === '' ? null : roleKey, status: 'active' },
    ],
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

// Step-up (K7) runs against the real producer and consumer: the e2e test issuer mints the ID
// token, a real JwtVerifier checks it against the issuer's JWKS.
const PROJECT = '300000000000000001';
const CLIENT = '300000000000000002';
let issuer: TestIssuer;
let verifier: JwtVerifier;

beforeAll(async () => {
  Logger.overrideLogger(false);
  issuer = await startTestIssuer();
  verifier = new JwtVerifier({ issuer: issuer.url, audience: PROJECT, allowedAzp: [CLIENT] });
});
afterAll(async () => {
  verifier.onModuleDestroy();
  await issuer.close();
});

/** An ID token for the caller `me`, signed in `ago` seconds ago. */
const idToken = (ago = 10, sub = 'me') =>
  issuer.mintIdToken({ sub, authTime: nowS() - ago, audience: [CLIENT] });

/**
 * The request the AuthGuard leaves behind. `authTime` puts a fresh sign-in time on the access
 * identity (the removed path): step-up must ignore it and read only the ID token header.
 */
function reqWith(authTime?: number): AuthenticatedRequest {
  return {
    auth: {
      userId: 'me',
      zitadelOrgId: 'o',
      roles: ['founder'],
      tokenExp: nowS() + 600,
      ...(authTime === undefined ? {} : { authTime }),
    },
  } as unknown as AuthenticatedRequest;
}

function approvalsController(current: unknown = requestAt('management'), maxAge?: number) {
  const service = {
    preview: vi.fn(() => Promise.resolve({ steps: [], blocked: true })),
    inboxPage: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
    get: vi.fn(() => Promise.resolve(current)),
    getForAction: vi.fn(() => Promise.resolve(current)),
    act: vi.fn(() => Promise.resolve({})),
    reroute: vi.fn(() => Promise.resolve({})),
  };
  const caller = {
    current: () => ({
      scope: { tenantId: 't', organizationId: 'o' },
      principal: { userId: 'me' },
    }),
  };
  return {
    service,
    controller: new ApprovalsController(service as never, caller as never, verifier, maxAge),
  };
}

const res = () => ({ setHeader: vi.fn() });

describe('ApprovalsController', () => {
  it('refuses a decision without an Idempotency-Key header with 400', () => {
    const { controller, service } = approvalsController();
    expect(() =>
      controller.act(ID, undefined, { action: 'approve', expectedVersion: 1 }, reqWith()),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.act(ID, 'has space', { action: 'approve', expectedVersion: 1 }, reqWith()),
    ).toThrow(BadRequestException);
    expect(service.act).not.toHaveBeenCalled();
  });

  it('refuses a return without a comment with 400 before the service runs', () => {
    const { controller, service } = approvalsController();
    expect(() =>
      controller.act(ID, 'key-1', { action: 'return', expectedVersion: 1 }, reqWith()),
    ).toThrow(/comment/);
    expect(service.act).not.toHaveBeenCalled();
  });

  it('passes a valid decision through with its key', async () => {
    const { controller, service } = approvalsController();
    await controller.act(ID, 'key-1', { action: 'approve', expectedVersion: 3 }, reqWith());
    expect(service.act).toHaveBeenCalledWith(
      ID,
      { action: 'approve', expectedVersion: 3 },
      'key-1',
    );
    expect(service.getForAction).toHaveBeenCalledWith(
      ID,
      { action: 'approve', expectedVersion: 3 },
      'key-1',
    );
  });

  describe('step-up for Founder steps (K7)', () => {
    const approve = { action: 'approve', expectedVersion: 3 } as const;

    async function refusal(promise: Promise<unknown>): Promise<StepUpRequiredException> {
      const err: unknown = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StepUpRequiredException);
      const ex = err as StepUpRequiredException;
      expect(ex.getStatus()).toBe(401);
      expect(ex.getResponse()).toMatchObject({ code: STEP_UP_REQUIRED });
      return ex;
    }

    it('lets a Founder approve with a fresh ID token, though the access token has no auth_time', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await controller.act(ID, 'key-1', approve, reqWith(), await idToken());
      expect(service.act).toHaveBeenCalledWith(ID, approve, 'key-1');
    });

    it('refuses a missing ID token header with 401 step_up_required and never acts', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 10)));
      expect(service.act).not.toHaveBeenCalled();
    });

    it('refuses a stale ID token, even when the access identity claims a fresh sign-in', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 10), await idToken(301)));
      expect(service.act).not.toHaveBeenCalled();
    });

    it("refuses another user's ID token", async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(
        controller.act(
          ID,
          'key-1',
          approve,
          reqWith(nowS() - 10),
          await idToken(10, 'someone-else'),
        ),
      );
      expect(service.act).not.toHaveBeenCalled();
    });

    it('refuses an access token sent as the ID token', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      const accessToken = await issuer.mint(
        { sub: 'me', azp: CLIENT },
        { audience: [PROJECT, CLIENT], authTime: nowS() - 10 },
      );
      await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 10), accessToken));
      expect(service.act).not.toHaveBeenCalled();
    });

    it('needs step-up when a department-head step falls back to the founder role', async () => {
      const { controller, service } = approvalsController(requestAt('founder', 'department_head'));
      await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 10)));
      expect(service.act).not.toHaveBeenCalled();
    });

    it('needs step-up for return and reject on a Founder step too', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(
        controller.act(
          ID,
          'key-1',
          { action: 'reject', comment: 'no', expectedVersion: 3 },
          reqWith(),
          await idToken(301),
        ),
      );
      expect(service.act).not.toHaveBeenCalled();
    });

    it.each([
      ['management role', requestAt('management')],
      ['finance role', requestAt('finance')],
      ['group', requestAt('', 'group')],
      ['named user', requestAt('', 'user')],
      ['department head in post', requestAt('', 'department_head')],
      [
        'department head falling back to operations_head',
        requestAt('operations_head', 'department_head'),
      ],
    ])('leaves a %s step alone, with no ID token header', async (_label, current) => {
      const { controller, service } = approvalsController(current);
      await controller.act(ID, 'key-1', approve, reqWith());
      expect(service.act).toHaveBeenCalledWith(ID, approve, 'key-1');
    });

    it('ignores a junk ID token header on a non-Founder step', async () => {
      const { controller, service } = approvalsController(requestAt('management'));
      await controller.act(ID, 'key-1', approve, reqWith(), 'junk');
      expect(service.act).toHaveBeenCalledWith(ID, approve, 'key-1');
    });

    it('fails closed when the client claims a version newer than the request', async () => {
      // The step could move to Founder between this read and the service's lock.
      const { controller, service } = approvalsController(requestAt('management'));
      await refusal(
        controller.act(ID, 'key-1', { action: 'approve', expectedVersion: 4 }, reqWith()),
      );
      expect(service.act).not.toHaveBeenCalled();
    });

    it('lets an outdated version through to the service, which answers 409', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await controller.act(ID, 'key-1', { action: 'approve', expectedVersion: 2 }, reqWith());
      expect(service.act).toHaveBeenCalled();
    });

    it('fails closed when the request has no step at currentSeq', async () => {
      const { controller, service } = approvalsController({
        ...requestAt('management'),
        steps: [],
      });
      await refusal(controller.act(ID, 'key-1', approve, reqWith()));
      expect(service.act).not.toHaveBeenCalled();
    });

    it('uses the configured window', async () => {
      const { controller, service } = approvalsController(requestAt('founder'), 60);
      const ex = await refusal(controller.act(ID, 'key-1', approve, reqWith(), await idToken(120)));
      expect(ex.getResponse()).toMatchObject({ maxAge: 60 });
      expect(service.act).not.toHaveBeenCalled();
    });
  });

  it('previews with the caller as the SoD user by default', async () => {
    const { controller, service } = approvalsController();
    await controller.preview({ documentType: 'test_memo', facts: { amountNpr: '1' } });
    expect(service.preview).toHaveBeenCalledWith(
      { tenantId: 't', organizationId: 'o' },
      'test_memo',
      { amountNpr: '1' },
      ['me'],
    );
    expect(() => controller.preview({ documentType: '' })).toThrow(BadRequestException);
  });

  it('delegates inbox, get and reroute', async () => {
    const { controller, service } = approvalsController();
    await controller.inbox({}, res());
    await controller.get(ID);
    await controller.reroute(ID);
    expect(service.inboxPage).toHaveBeenCalled();
    expect(service.get).toHaveBeenCalledWith(ID);
    expect(service.reroute).toHaveBeenCalledWith(ID);
  });

  describe('inbox query', () => {
    const item = { requestId: ID };

    it('returns the bare array and the total in X-Total-Count; no params means no limit', async () => {
      const { controller, service } = approvalsController();
      service.inboxPage.mockResolvedValueOnce({ items: [item], total: 41 } as never);
      const out = res();
      expect(await controller.inbox({}, out)).toEqual([item]);
      expect(out.setHeader).toHaveBeenCalledWith('X-Total-Count', '41');
      expect(service.inboxPage).toHaveBeenCalledWith({ offset: 0 });
    });

    it('parses a single and a repeated documentType, q, limit and offset', async () => {
      const { controller, service } = approvalsController();
      await controller.inbox(
        { q: ' INV-0042 ', documentType: 'tax_invoice', limit: '10', offset: '20' },
        res(),
      );
      expect(service.inboxPage).toHaveBeenLastCalledWith({
        q: 'INV-0042',
        documentType: ['tax_invoice'],
        limit: 10,
        offset: 20,
      });
      await controller.inbox({ documentType: ['tax_invoice', 'test_memo', 'tax_invoice'] }, res());
      expect(service.inboxPage).toHaveBeenLastCalledWith({
        documentType: ['tax_invoice', 'test_memo'],
        offset: 0,
      });
    });

    it('treats an empty documentType and a one-character q as no filter', async () => {
      const { controller, service } = approvalsController();
      await controller.inbox({ documentType: '', q: 'a' }, res());
      expect(service.inboxPage).toHaveBeenLastCalledWith({ documentType: [], offset: 0 });
    });

    it.each([
      ['an unknown param', { status: 'pending' }],
      ['an uppercase documentType', { documentType: 'Tax_Invoice' }],
      ['a documentType with a dash', { documentType: 'tax-invoice' }],
      ['limit 0', { limit: '0' }],
      ['limit 101', { limit: '101' }],
      ['a negative offset', { offset: '-1' }],
    ])('refuses %s with 400 before the service runs', async (_name, query) => {
      const { controller, service } = approvalsController();
      await expect(controller.inbox(query, res())).rejects.toBeInstanceOf(BadRequestException);
      expect(service.inboxPage).not.toHaveBeenCalled();
    });
  });

  it('keeps static permissions where possible and delegates record-specific eligibility to the service', () => {
    const expected: Record<string, string> = {
      preview: 'approvals.requests.read',
      reroute: 'approvals.requests.reroute',
    };
    for (const [method, permission] of Object.entries(expected)) {
      const handler = ApprovalsController.prototype[method as keyof ApprovalsController];
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBe(permission);
    }
    for (const handler of [
      ApprovalsController.prototype.inbox,
      ApprovalsController.prototype.get,
      ApprovalsController.prototype.act,
    ]) {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBe(true);
    }
  });
});

describe('admin controllers', () => {
  const admin = {
    listWorkflows: vi.fn(() => Promise.resolve([])),
    createWorkflow: vi.fn(() => Promise.resolve({})),
    addVersion: vi.fn(() => Promise.resolve({})),
    publish: vi.fn(() => Promise.resolve({})),
    listGroups: vi.fn(() => Promise.resolve([])),
    createGroup: vi.fn(() => Promise.resolve({ id: ID })),
    deleteGroup: vi.fn(() => Promise.resolve(undefined)),
    addMember: vi.fn(() => Promise.resolve(undefined)),
    removeMember: vi.fn(() => Promise.resolve(undefined)),
    listDelegations: vi.fn(() => Promise.resolve([])),
    createDelegation: vi.fn(() => Promise.resolve({ id: ID })),
    revokeDelegation: vi.fn(() => Promise.resolve(undefined)),
  };

  it('validates workflow bodies and passes them on', async () => {
    const c = new AdminWorkflowsController(admin as never, {} as never, {} as never);
    await c.list();
    await c.create({ key: 'test_memo', name: 'Memo', spec: {} });
    await c.addVersion('test_memo', { spec: { a: 1 } });
    await c.publish('test_memo', 2);
    expect(admin.createWorkflow).toHaveBeenCalledWith({ key: 'test_memo', name: 'Memo', spec: {} });
    expect(admin.addVersion).toHaveBeenCalledWith('test_memo', { a: 1 });
    // Publishing names its live re-check of the publisher's grant (run inside the publish transaction).
    expect(admin.publish).toHaveBeenCalledWith('test_memo', 2, expect.any(Function), {});
    // The small-team rule's reason (F1-Q11 a) is trimmed and passed on; unknown body fields are refused.
    await c.publish('test_memo', 3, { reason: '  Only Founder  ' });
    expect(admin.publish).toHaveBeenLastCalledWith('test_memo', 3, expect.any(Function), {
      reason: 'Only Founder',
    });
    expect(() => c.publish('test_memo', 3, { soleEligible: true })).toThrow(BadRequestException);
    expect(() => c.create({ key: 'Bad Key', name: 'x', spec: {} })).toThrow(BadRequestException);
    expect(Reflect.getMetadata(CAN_KEY, AdminWorkflowsController.prototype.list)).toBe(
      'approvals.definitions.read',
    );
    expect(Reflect.getMetadata(CAN_KEY, AdminWorkflowsController.prototype.publish)).toBe(
      'approvals.definitions.publish',
    );
  });

  it('validates group and delegation bodies and passes them on', async () => {
    const g = new AdminApprovalGroupsController(admin as never);
    await g.list();
    await g.create({ key: 'treasury', name: 'Treasury' });
    await g.addMember(ID, { userId: ID });
    await g.removeMember(ID, ID);
    await g.remove(ID);
    expect(() => g.addMember(ID, { userId: 'not-a-uuid' })).toThrow(BadRequestException);

    const d = new AdminDelegationsController(admin as never);
    await d.list();
    await d.create({
      fromUserId: ID,
      toUserId: ID,
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-11-02T00:00:00+05:45',
    });
    expect(admin.createDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: null, startsAt: new Date('2026-11-01T00:00:00Z') }),
    );
    await d.revoke(ID);
    expect(admin.revokeDelegation).toHaveBeenCalledWith(ID);
    expect(Reflect.getMetadata(CAN_KEY, AdminDelegationsController.prototype.create)).toBe(
      'approvals.delegations.write',
    );
    expect(Reflect.getMetadata(CAN_KEY, AdminApprovalGroupsController.prototype.remove)).toBe(
      'approvals.groups.write',
    );
  });
});

describe('SLA processor', () => {
  it('runs the tick for approvals.sla and fails on unknown jobs', async () => {
    const sla = { tick: vi.fn(() => Promise.resolve({ reminded: 0, escalated: 0 })) };
    const processor = new ApprovalsSlaProcessor(sla as never);
    await processor.process({ name: SLA_JOB } as never);
    expect(sla.tick).toHaveBeenCalledTimes(1);
    await expect(processor.process({ name: 'approvals.other' } as never)).rejects.toThrow(
      /Unknown/,
    );
  });

  it('schedules the tick every 5 minutes, idempotently', async () => {
    const queue = { upsertJobScheduler: vi.fn(() => Promise.resolve(undefined)) };
    await new ApprovalsSlaScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SLA_JOB,
      { every: SLA_EVERY_MS },
      expect.objectContaining({ name: SLA_JOB }),
    );
    expect(SLA_EVERY_MS).toBe(300_000);
  });
});
