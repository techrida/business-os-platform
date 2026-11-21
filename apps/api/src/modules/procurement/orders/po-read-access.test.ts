// Unit tests of who may read purchase orders (F1-Q52): procurement as before, and read-only the accountant, finance
// and the warehouse through their live bill and receipt grants; management, a requester, an inactive user and a
// portal caller are refused. Also the routes: the reads are @AnyAuthenticated (the service decides), every write still
// needs procurement.po.issue, and the PDF download follows the reads while its Retry stays with issuers.
import 'reflect-metadata';

import {
  DEFAULT_ROLE_PERMISSIONS,
  PO_STATUSES,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../../platform/authz/decorators';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import {
  approvesPo,
  assertHoldsPoRead,
  holdsPoRead,
  mayReadPo,
  mayReceivePo,
  poReadWhere,
} from './po-read-access';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrderDocumentController } from './render/purchase-order-document.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const SOMEONE_ELSE = '33333333-3333-4333-8333-333333333333';
const DEPT = '44444444-4444-4444-8444-444444444444';

const principalOf = (roles: RoleKey[], over: Partial<Principal> = {}): Principal => ({
  userId: ME,
  zitadelUserId: 'z-1',
  tenantId: ORG,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles,
  departmentId: null,
  status: 'active',
  grants: new Map(
    roles.flatMap((r) => Object.entries(DEFAULT_ROLE_PERMISSIONS[r])) as [Permission, Scope][],
  ),
  ...over,
});

const requestOf = (requesterUserId: string) => ({
  tenantId: ORG,
  organizationId: ORG,
  requesterUserId,
  departmentId: DEPT,
});
const THEIRS = requestOf(SOMEONE_ELSE);

describe('holdsPoRead and mayReadPo', () => {
  it('open the order to procurement, the founder, the accountant, finance and the warehouse', () => {
    for (const role of ['procurement', 'founder', 'accountant', 'finance', 'warehouse'] as const) {
      const p = principalOf([role]);
      expect(holdsPoRead(p), role).toBe(true);
      expect(mayReadPo(p, THEIRS), role).toBe(true);
      expect(() => assertHoldsPoRead(p)).not.toThrow();
    }
  });

  it('refuse management and a requester, who hold none of the grants (403 before any read)', () => {
    for (const role of ['management', 'operations_officer', 'sales'] as const) {
      const p = principalOf([role]);
      expect(holdsPoRead(p), role).toBe(false);
      expect(mayReadPo(p, requestOf(ME)), role).toBe(false);
      expect(() => assertHoldsPoRead(p)).toThrow(ForbiddenException);
    }
  });

  it('refuse an inactive user and a portal caller, whatever they hold', () => {
    const inactive = principalOf(['founder'], { status: 'inactive' });
    const vendor = principalOf(['founder'], { orgKind: 'vendor' });
    for (const p of [inactive, vendor]) {
      expect(holdsPoRead(p)).toBe(false);
      expect(mayReadPo(p, THEIRS)).toBe(false);
    }
    expect(() => assertHoldsPoRead(inactive)).toThrow(ForbiddenException);
  });

  it('follow a narrower read-only grant to the orders of its own requests only', () => {
    const p = principalOf(['accountant']);
    const grants = p.grants as Map<Permission, Scope>;
    grants.set('payables.bill.enter', 'own');
    grants.set('payables.bill.read', 'own');
    expect(mayReadPo(p, requestOf(ME))).toBe(true);
    expect(mayReadPo(p, THEIRS)).toBe(false);
    expect(mayReadPo(p, { ...requestOf(ME), organizationId: SOMEONE_ELSE })).toBe(false);
    // The list filters in SQL for a read-only reader; an issuer reads the whole entity unfiltered.
    expect(poReadWhere(p)).toBeDefined();
    expect(poReadWhere(principalOf(['procurement']))).toBeUndefined();
  });
});

describe('approvesPo', () => {
  it('opens nothing to an inactive user, a portal caller or another entity, before reading anything', async () => {
    const q = new Proxy({} as Db, {
      get: () => {
        throw new Error('read');
      },
    });
    const inbox = () => Promise.reject(new Error('inbox'));
    const scope = { tenantId: ORG, organizationId: ORG };
    for (const p of [
      principalOf(['management'], { status: 'inactive' }),
      principalOf(['management'], { orgKind: 'vendor' }),
      principalOf(['management'], { organizationId: SOMEONE_ELSE }),
    ]) {
      await expect(approvesPo(q, scope, p, SOMEONE_ELSE, inbox)).resolves.toBe(false);
    }
  });
});

describe('mayReceivePo', () => {
  it('offers Receive goods to the warehouse, on orders that still take receipts only', () => {
    const p = principalOf(['warehouse']);
    for (const status of PO_STATUSES) {
      expect(mayReceivePo(p, status, THEIRS, false), status).toBe(
        status === 'issued' || status === 'partially_received',
      );
    }
  });

  it('never offers it to a read-only reader, even on a service order (the requester of a service may)', () => {
    for (const role of ['accountant', 'finance', 'procurement'] as const) {
      expect(mayReceivePo(principalOf([role]), 'issued', THEIRS, true), role).toBe(false);
    }
    expect(mayReceivePo(principalOf(['operations_officer']), 'issued', requestOf(ME), true)).toBe(
      true,
    );
    expect(mayReceivePo(principalOf(['operations_officer']), 'issued', requestOf(ME), false)).toBe(
      false,
    );
  });
});

describe('purchase order routes', () => {
  const proto = PurchaseOrdersController.prototype;

  it('leave the reads to the service and keep procurement.po.issue on every write', () => {
    for (const read of [proto.list, proto.get, proto.versions]) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, read)).toBe(true);
      expect(Reflect.getMetadata(CAN_KEY, read)).toBeUndefined();
    }
    for (const write of [proto.issue, proto.amend, proto.shortClose, proto.cancel]) {
      expect(Reflect.getMetadata(CAN_KEY, write)).toBe('procurement.po.issue');
    }
  });

  it('open the PDF download like the reads, and keep its Retry with issuers', () => {
    const doc = PurchaseOrderDocumentController.prototype;
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, doc.link)).toBe(true);
    expect(Reflect.getMetadata(CAN_KEY, doc.link)).toBeUndefined();
    expect(Reflect.getMetadata(CAN_KEY, doc.retry)).toBe('procurement.po.issue');
  });
});
