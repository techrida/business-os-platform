// F1-Q51: an opportunity's owner can be changed under the same assignment rule as a lead's owner (D38/D50, the
// entity's stored rule for opportunities); the old owner's open follow-ups on the deal move with it (D45); the change
// is audited, the new owner is told (`crm.assigned`), and the deal's department follows the new owner (D55-4).
// Real: migrations, triggers, RoleCache, the assignment rule, AuditService, NotifyService's outbox.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { ASSIGNMENT_DENY_MESSAGES, OpportunityDtoSchema } from '@bos/contracts';
import { activities, opportunities } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { systemActor, withTx } from '../../platform/db/tx';
import { startHarness, type Harness } from '../leads/test/harness';
import type { OpportunitiesCaller } from './opportunities.caller';
import { OpportunityOwnerChangeService } from './opportunity-owner-change.service';
import { OpportunityOwnersService } from './opportunity-owners.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let service: OpportunityOwnerChangeService;
let owners: OpportunityOwnersService;
let customerId: string;
let salesDept: string;
let otherSalesDept: string;
let salesStaff: string;
let salesPeer: string;
let salesManager: string;
let elsewhere: string;
let seq = 0;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const caller = h.caller as unknown as OpportunitiesCaller;
  service = new OpportunityOwnerChangeService(
    h.db,
    caller,
    h.authz as unknown as AuthzService,
    new AuditService(h.db),
    h.notify,
    h.roleCache,
  );
  owners = new OpportunityOwnersService(h.db, caller, h.roleCache);
  salesDept = await h.department('Sales OC');
  otherSalesDept = await h.department('Sales OC North');
  const sales = { roles: ['sales'] as const, departmentId: salesDept };
  salesStaff = await h.member({ ...sales, displayName: 'Sam Staff' });
  salesPeer = await h.member({ ...sales, displayName: 'Pia Peer' });
  salesManager = await h.member({ ...sales, level: 'manager', displayName: 'Mina Manager' });
  elsewhere = await h.member({
    roles: ['sales'],
    departmentId: otherSalesDept,
    displayName: 'Nara North',
  });
  customerId = await h.seedCustomer(salesStaff);
});

afterAll(async () => {
  await h?.stop();
});

async function seedDeal(ownerUserId: string, stage: 'negotiation' | 'lost' = 'negotiation') {
  seq += 1;
  const id = randomUUID();
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(opportunities).values({
      id,
      tenantId: h.tenantId,
      organizationId: h.scopeA.organizationId,
      number: `DEAL-OC-${String(seq).padStart(4, '0')}`,
      name: `Owner change deal ${seq}`,
      customerId,
      ownerUserId,
      stage,
      ...(stage === 'lost' ? { stageReason: 'Price', stageNote: 'Went elsewhere' } : {}),
      value: '125000.00',
      currency: 'NPR',
    }),
  );
  return id;
}

async function plan(
  opportunityId: string,
  assigneeUserId: string | null,
  done?: 'completed' | 'cancelled',
) {
  const now = new Date();
  const [row] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx
      .insert(activities)
      .values({
        ...h.scopeA,
        kind: 'call',
        subject: 'Follow up on the deal',
        opportunityId,
        dueAt: new Date(Date.now() + 86_400_000),
        assigneeUserId,
        createdByUserId: salesStaff,
        completedAt: done === 'completed' ? now : null,
        cancelledAt: done === 'cancelled' ? now : null,
      })
      .returning(),
  );
  return row!;
}

const dealRow = async (id: string) =>
  (await h.db.select().from(opportunities).where(eq(opportunities.id, id)))[0]!;
const activityRow = async (id: string) =>
  (await h.db.select().from(activities).where(eq(activities.id, id)))[0]!;

async function refusal(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return (error.getResponse() as { details?: { assignmentReason?: string } }).details
      ?.assignmentReason;
  }
  throw new Error('expected a 400');
}

async function assignedNotices(opportunityId: string) {
  const { rows } = await h.ownerPool.query(
    `SELECT to_user_id, body_text FROM app.outbox
      WHERE tenant_id = $1 AND template = 'crm.assigned' AND dedupe_key LIKE $2`,
    [h.tenantId, `crm.assigned:opportunity:${opportunityId}:%`],
  );
  return rows as { to_user_id: string; body_text: string }[];
}

describe('PATCH /v1/opportunities/:id/owner (F1-Q51)', () => {
  it('hands the deal to a peer: owner, department, follow-ups, audit and notice', async () => {
    const id = await seedDeal(salesStaff);
    expect((await dealRow(id)).departmentId).toBe(salesDept);
    const mine = await plan(id, salesStaff);
    const theirs = await plan(id, salesManager);
    const unassigned = await plan(id, null);
    const completed = await plan(id, salesStaff, 'completed');

    await h.actAs(salesStaff);
    const dto = OpportunityDtoSchema.parse(
      await service.changeOwner(id, { ownerUserId: salesPeer, expectedVersion: 1 }),
    );
    expect(dto).toMatchObject({ ownerUserId: salesPeer, ownerName: 'Pia Peer', version: 2 });

    const after = await dealRow(id);
    expect(after.ownerUserId).toBe(salesPeer);
    expect(after.departmentId).toBe(salesDept);

    expect((await activityRow(mine.id)).assigneeUserId).toBe(salesPeer);
    expect((await activityRow(mine.id)).version).toBe(mine.version + 1);
    expect((await activityRow(theirs.id)).assigneeUserId).toBe(salesManager);
    expect((await activityRow(unassigned.id)).assigneeUserId).toBeNull();
    expect((await activityRow(completed.id)).assigneeUserId).toBe(salesStaff);

    expect((await h.auditOf(id)).map((e) => e.action)).toContain('opportunity.owner_changed');
    const { rows } = await h.ownerPool.query(
      `SELECT entity_id, before, after, meta FROM audit.audit_events
        WHERE tenant_id = $1 AND action = 'activity.reassigned' AND meta ->> 'opportunityId' = $2`,
      [h.tenantId, id],
    );
    expect(rows).toEqual([
      {
        entity_id: mine.id,
        before: { assigneeUserId: salesStaff },
        after: { assigneeUserId: salesPeer },
        meta: { reason: 'opportunity_owner_changed', opportunityId: id },
      },
    ]);

    const notices = await assignedNotices(id);
    expect(notices.map((n) => n.to_user_id)).toEqual([salesPeer]);
    expect(notices[0]!.body_text).toContain('Sam Staff assigned the opportunity');
  });

  it('follows the new owner into another department when a manager hands it over', async () => {
    const id = await seedDeal(salesStaff);
    h.as('boss', 'founder');
    await service.changeOwner(id, { ownerUserId: elsewhere, expectedVersion: 1 });
    expect(await dealRow(id)).toMatchObject({
      ownerUserId: elsewhere,
      departmentId: otherSalesDept,
    });
  });

  it('refuses whom the assignment rule refuses, with the rule code, and changes nothing', async () => {
    const id = await seedDeal(salesStaff);
    const mine = await plan(id, salesStaff);
    await h.actAs(salesStaff);
    expect(
      await refusal(() =>
        service.changeOwner(id, { ownerUserId: salesManager, expectedVersion: 1 }),
      ),
    ).toBe('upward');
    try {
      await service.changeOwner(id, { ownerUserId: salesManager, expectedVersion: 1 });
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: `ownerUserId ${ASSIGNMENT_DENY_MESSAGES.upward}`,
      });
    }
    expect(
      await refusal(() => service.changeOwner(id, { ownerUserId: elsewhere, expectedVersion: 1 })),
    ).toBeDefined();
    expect((await dealRow(id)).ownerUserId).toBe(salesStaff);
    expect((await activityRow(mine.id)).assigneeUserId).toBe(salesStaff);
    expect(await assignedNotices(id)).toEqual([]);
  });

  it('answers 404 outside the write scope, 409 on a stale version, 400 on a closed deal or the same owner', async () => {
    const id = await seedDeal(salesStaff);
    await h.actAs(salesPeer);
    await expect(
      service.changeOwner(id, { ownerUserId: salesPeer, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await h.actAs(salesStaff);
    await expect(
      service.changeOwner(id, { ownerUserId: salesPeer, expectedVersion: 7 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.changeOwner(id, { ownerUserId: salesStaff, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const lost = await seedDeal(salesStaff, 'lost');
    await expect(
      service.changeOwner(lost, { ownerUserId: salesPeer, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    h.as('viewer', 'finance');
    await expect(
      service.changeOwner(id, { ownerUserId: salesPeer, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('offers in the owner select exactly the people the change accepts', async () => {
    await h.actAs(salesStaff);
    const offered = (await owners.owners()).map((o) => o.userId);
    expect(offered).toContain(salesPeer);
    expect(offered).toContain(salesStaff);
    expect(offered).not.toContain(salesManager);
    expect(offered).not.toContain(elsewhere);
    expect((await owners.owners()).every((o) => o.email === '')).toBe(true);
  });
});
