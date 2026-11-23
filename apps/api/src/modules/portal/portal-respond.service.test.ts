// Unit tests of the portal accept and reject (P2 unit PA-3) with fakes for the caller, the respond store, the
// outcome core and notify. They pin the order of the checks: a staff caller (even a founder holding the portal
// grants at `all`) gets 403 before the key, the body or any read; a missing Idempotency-Key is a 400; a version the
// store does not return, or one the customer may not see, is a 404 and never reaches the core; a visible version
// that is no longer Sent is a 409. The core is called with the customer's identity, `signed_quote` and today in
// Kathmandu, and the customer gets a narrow answer, never the internal AcceptanceDto.
import 'reflect-metadata';

import type { AcceptanceDto } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import type { Principal } from '../../platform/authz/principal';
import type { IdempotencyInput } from '../../platform/db/idempotency';
import type { QuotationOutcomeService } from '../quotations/outcome/quotation-outcome.service';
import { PortalRespondController } from './portal-respond.controller';
import { PortalRespondService } from './portal-respond.service';
import type { PortalVersionHead } from './portal.store';

const idempotency = vi.hoisted(() => ({ calls: [] as unknown[], replay: false }));

// withIdempotency is the kernel's and has its own tests; here it records what it was asked and runs the command.
vi.mock('../../platform/db/idempotency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withIdempotency: async (
    tx: unknown,
    input: unknown,
    fn: (tx: unknown) => Promise<{ status: number; response: unknown }>,
  ) => {
    idempotency.calls.push(input);
    return { ...(await fn(tx)), replayed: idempotency.replay };
  },
}));

const TENANT = '0a000000-0000-4000-8000-000000000001';
const ENTITY = '0a000000-0000-4000-8000-000000000002';
const PARTY = '0a000000-0000-4000-8000-000000000003';
const USER = '0a000000-0000-4000-8000-000000000009';
const VID = '1b000000-0000-4000-8000-000000000001';
const QID = '2c000000-0000-4000-8000-000000000001';
const KEY = 'accept-key-1';
// 2026-11-09 20:00 UTC is already 2026-11-10 in Kathmandu (UTC+05:45).
const NOW = new Date('2026-11-09T20:00:00Z');

function principalOf(over: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    zitadelUserId: 'zitadel-sub-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'customer',
    partyId: PARTY,
    idpOrgId: '0a000000-0000-4000-8000-00000000000a',
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map([['portal.quotation.respond', 'customer_org']]),
    ...over,
  };
}

const CUSTOMER = principalOf();
const FOUNDER = principalOf({
  orgKind: 'staff',
  partyId: null,
  roles: ['founder'],
  grants: new Map([['portal.quotation.respond', 'all']]),
});

function headOf(over: Partial<PortalVersionHead> = {}): PortalVersionHead {
  return {
    versionId: VID,
    quotationId: QID,
    number: 'QT-0001',
    revisionNo: 1,
    status: 'sent',
    rejectionSource: null,
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency: 'NPR',
    total: '1130.00',
    sentAt: new Date('2026-11-08T10:00:00Z'),
    quotationCancelled: false,
    ...over,
  };
}

function acceptanceOf(outcome: 'accepted' | 'rejected'): AcceptanceDto {
  return {
    id: '3d000000-0000-4000-8000-000000000001',
    versionId: VID,
    outcome,
    actorKind: 'customer_user',
    actorId: USER,
    decidedOn: '2026-11-10',
    comment: outcome === 'rejected' ? 'Too expensive' : null,
    evidenceKinds: outcome === 'accepted' ? ['signed_quote'] : [],
    evidenceDocumentIds: [],
    acceptedByName: outcome === 'accepted' ? 'Ram Thapa' : null,
  };
}

function setup(caller: Principal, head: PortalVersionHead | null = headOf()) {
  const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
  const db = { transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  const store = { findHead: vi.fn().mockResolvedValue(head ?? undefined) };
  const outcomes = {
    accept: vi.fn().mockResolvedValue(acceptanceOf('accepted')),
    reject: vi.fn().mockResolvedValue(acceptanceOf('rejected')),
  };
  const notify = { nudge: vi.fn().mockResolvedValue(undefined) };
  const actor = { kind: 'user' as const, id: caller.userId, correlationId: 'req-1' };
  const service = new PortalRespondService(
    db as never,
    { current: () => caller },
    { current: () => actor },
    store,
    outcomes as unknown as QuotationOutcomeService,
    notify as never,
    () => NOW,
  );
  return { service, db, tx, store, outcomes, notify };
}

beforeEach(() => {
  idempotency.calls = [];
  idempotency.replay = false;
});

describe('PortalRespondController', () => {
  it('marks accept and reject with portal.quotation.respond, and the id with a UUID pipe', () => {
    for (const name of ['accept', 'reject'] as const) {
      expect(Reflect.getMetadata(CAN_KEY, PortalRespondController.prototype[name])).toBe(
        'portal.quotation.respond',
      );
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        PortalRespondController,
        name,
      ) as Record<string, { data: string; pipes: unknown[] }>;
      expect(Object.values(args).find((a) => a.data === 'id')?.pipes).toContain(ParseUUIDPipe);
    }
  });
});

describe('PortalRespondService', () => {
  it('answers 403 to a staff founder before the key, the body or any read', async () => {
    const { service, db, store, outcomes } = setup(FOUNDER);
    await expect(service.accept(VID, undefined, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reject(VID, KEY, { comment: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.transaction).not.toHaveBeenCalled();
    expect(store.findHead).not.toHaveBeenCalled();
    expect(outcomes.accept).not.toHaveBeenCalled();
    expect(outcomes.reject).not.toHaveBeenCalled();
  });

  it('answers 403 to a customer principal with no party', async () => {
    const { service, db } = setup(principalOf({ partyId: null }));
    await expect(
      service.accept(VID, KEY, { acceptedByName: 'Ram', confirm: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('answers 400 without an Idempotency-Key, or with a bad body, before any read', async () => {
    const { service, db } = setup(CUSTOMER);
    await expect(
      service.accept(VID, undefined, { acceptedByName: 'Ram', confirm: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.accept(VID, '', { acceptedByName: 'Ram', confirm: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.accept(VID, KEY, { acceptedByName: 'Ram' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.accept(VID, KEY, { acceptedByName: 'Ram', confirm: true, evidenceKinds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reject(VID, KEY, { comment: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.reject(VID, KEY, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('accepts through the core as the customer, with signed_quote and today in Kathmandu', async () => {
    const { service, store, outcomes, notify, tx } = setup(CUSTOMER);
    const out = await service.accept(VID, KEY, { acceptedByName: '  Ram Thapa ', confirm: true });

    expect(store.findHead).toHaveBeenCalledWith(tx, CUSTOMER, VID);
    expect(outcomes.accept).toHaveBeenCalledWith(tx, {
      versionId: VID,
      quotationId: QID,
      actorKind: 'customer_user',
      actorUserId: USER,
      decidedOn: '2026-11-10',
      acceptedByName: 'Ram Thapa',
      evidenceKinds: ['signed_quote'],
    });
    expect(idempotency.calls).toEqual([
      {
        command: 'portal.quotation.accept',
        key: KEY,
        body: { id: VID, acceptedByName: 'Ram Thapa', confirm: true },
      },
    ] satisfies IdempotencyInput[]);
    expect(out).toEqual({ id: VID, status: 'accepted', decidedOn: '2026-11-10' });
    expect(notify.nudge).toHaveBeenCalledTimes(1);
  });

  it('rejects through the core with the comment and the customer as the source', async () => {
    const { service, outcomes, notify, tx } = setup(CUSTOMER);
    const out = await service.reject(VID, KEY, { comment: ' Too expensive ' });

    expect(outcomes.reject).toHaveBeenCalledWith(tx, {
      versionId: VID,
      quotationId: QID,
      actorKind: 'customer_user',
      actorUserId: USER,
      decidedOn: '2026-11-10',
      comment: 'Too expensive',
      rejectionSource: 'customer',
    });
    expect(idempotency.calls).toEqual([
      { command: 'portal.quotation.reject', key: KEY, body: { id: VID, comment: 'Too expensive' } },
    ]);
    expect(out).toEqual({ id: VID, status: 'rejected', decidedOn: '2026-11-10' });
    expect(notify.nudge).not.toHaveBeenCalled();
  });

  it('does not nudge again on a replay', async () => {
    idempotency.replay = true;
    const { service, notify } = setup(CUSTOMER);
    await service.accept(VID, KEY, { acceptedByName: 'Ram', confirm: true });
    expect(notify.nudge).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown or another party', null],
    ['draft', headOf({ status: 'draft' })],
    ['approved, not yet sent', headOf({ status: 'approved' })],
    ['rejected internally', headOf({ status: 'rejected', rejectionSource: 'internal' })],
  ])('answers 404 for a version that is %s, without calling the core', async (_name, head) => {
    const { service, outcomes } = setup(CUSTOMER, head);
    await expect(
      service.accept(VID, KEY, { acceptedByName: 'Ram', confirm: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reject(VID, KEY, { comment: 'No' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(outcomes.accept).not.toHaveBeenCalled();
    expect(outcomes.reject).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', headOf({ status: 'accepted' }), 'quotation_not_sent'],
    [
      'rejected by the customer',
      headOf({ status: 'rejected', rejectionSource: 'customer' }),
      'quotation_not_sent',
    ],
    ['superseded', headOf({ status: 'superseded' }), 'quotation_not_sent'],
    [
      'superseded of a cancelled quotation',
      headOf({ status: 'superseded', quotationCancelled: true }),
      'quotation_closed',
    ],
    ['expired', headOf({ status: 'expired' }), 'quotation_expired'],
  ])(
    'answers 409 for a visible version that is %s, without calling the core',
    async (_n, head, code) => {
      const { service, outcomes } = setup(CUSTOMER, head);
      const error = await service
        .accept(VID, KEY, { acceptedByName: 'Ram', confirm: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code });
      expect(outcomes.accept).not.toHaveBeenCalled();
    },
  );
});
