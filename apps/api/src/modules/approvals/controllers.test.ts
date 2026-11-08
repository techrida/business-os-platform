// Unit tests for the thin HTTP layer and the SLA processor wiring: header and body validation (400s),
// route permissions, and the job names. The services are fakes; their rules are tested on Postgres in
// approvals.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../platform/auth/claims';
import { STEP_UP_REQUIRED, StepUpRequiredException } from '../../platform/auth/step-up';
import { CAN_KEY } from '../../platform/authz/decorators';
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

/** A request at version 3 whose active step (seq 2) needs `roleKey`. */
function requestAt(roleKey: string, kind: 'role' | 'group' | 'user' = 'role') {
  return {
    requestId: ID,
    version: 3,
    currentSeq: 2,
    steps: [
      { seq: 1, kind: 'role', roleKey: 'finance', status: 'approved' },
      { seq: 2, kind, roleKey: kind === 'role' ? roleKey : null, status: 'active' },
    ],
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

/** The request the AuthGuard leaves behind, with the given `auth_time` (seconds). */
function reqWith(authTime?: number | null): AuthenticatedRequest {
  return {
    auth: {
      userId: 'me',
      zitadelOrgId: 'o',
      roles: ['founder'],
      tokenExp: nowS() + 600,
      ...(authTime === undefined ? {} : { authTime }),
    },
  } as AuthenticatedRequest;
}

function approvalsController(current: unknown = requestAt('management'), maxAge?: number) {
  const service = {
    preview: vi.fn(() => Promise.resolve({ steps: [], blocked: true })),
    inbox: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve(current)),
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
    controller: new ApprovalsController(service as never, caller as never, maxAge),
  };
}

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

    it('lets a Founder approve with a sign-in inside the window', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await controller.act(ID, 'key-1', approve, reqWith(nowS() - 60));
      expect(service.act).toHaveBeenCalledWith(ID, approve, 'key-1');
    });

    it('refuses a stale sign-in with 401 step_up_required and never acts', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 301)));
      expect(service.act).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', reqWith()],
      ['null', reqWith(null)],
    ])('fails closed when auth_time is %s', async (_label, req) => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(controller.act(ID, 'key-1', approve, req));
      expect(service.act).not.toHaveBeenCalled();
    });

    it('needs step-up for return and reject on a Founder step too', async () => {
      const { controller, service } = approvalsController(requestAt('founder'));
      await refusal(
        controller.act(
          ID,
          'key-1',
          { action: 'reject', comment: 'no', expectedVersion: 3 },
          reqWith(nowS() - 301),
        ),
      );
      expect(service.act).not.toHaveBeenCalled();
    });

    it.each([
      ['management role', requestAt('management')],
      ['finance role', requestAt('finance')],
      ['group', requestAt('', 'group')],
      ['named user', requestAt('', 'user')],
    ])('leaves a %s step alone, even with no auth_time', async (_label, current) => {
      const { controller, service } = approvalsController(current);
      await controller.act(ID, 'key-1', approve, reqWith());
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
      const ex = await refusal(controller.act(ID, 'key-1', approve, reqWith(nowS() - 120)));
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
    await controller.inbox();
    await controller.get(ID);
    await controller.reroute(ID);
    expect(service.inbox).toHaveBeenCalled();
    expect(service.get).toHaveBeenCalledWith(ID);
    expect(service.reroute).toHaveBeenCalledWith(ID);
  });

  it('puts a permission on every route', () => {
    const expected: Record<string, string> = {
      preview: 'approvals.requests.read',
      inbox: 'approvals.requests.act',
      get: 'approvals.requests.read',
      act: 'approvals.requests.act',
      reroute: 'approvals.requests.reroute',
    };
    for (const [method, permission] of Object.entries(expected)) {
      const handler = ApprovalsController.prototype[method as keyof ApprovalsController];
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBe(permission);
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
    const c = new AdminWorkflowsController(admin as never);
    await c.list();
    await c.create({ key: 'test_memo', name: 'Memo', spec: {} });
    await c.addVersion('test_memo', { spec: { a: 1 } });
    await c.publish('test_memo', 2);
    expect(admin.createWorkflow).toHaveBeenCalledWith({ key: 'test_memo', name: 'Memo', spec: {} });
    expect(admin.addVersion).toHaveBeenCalledWith('test_memo', { a: 1 });
    expect(admin.publish).toHaveBeenCalledWith('test_memo', 2);
    expect(() => c.create({ key: 'Bad Key', name: 'x', spec: {} })).toThrow(BadRequestException);
    expect(Reflect.getMetadata(CAN_KEY, AdminWorkflowsController.prototype.list)).toBe(
      'approvals.definitions.read',
    );
    expect(Reflect.getMetadata(CAN_KEY, AdminWorkflowsController.prototype.publish)).toBe(
      'approvals.definitions.write',
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
