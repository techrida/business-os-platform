// Unit tests of the purchase request rules (P4 unit P1): line arithmetic, the approval facts, the body envelope, and
// above all the `purchase_request` route, planned by the real router from the real spec (AD10, AD11, AD12).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/purchase-request.rules.test.ts
import {
  DEFAULT_ROLE_PERMISSIONS,
  PurchaseRequestLineBodySchema,
  WorkflowSpecSchema,
  type Permission,
  type PrStatus,
  type RoleKey,
  type RoutePlan,
  type Scope,
} from '@bos/contracts';
import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import { buildDirectory, route, type DirectoryData } from '../../approvals/router';
import {
  ExpectedVersionEnvelopeSchema,
  ListPurchaseRequestsQuerySchema,
  PR_STATUS_AFTER_DECISION,
  PURCHASE_REQUEST_DOCUMENT_TYPE,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
  approvalFactsOf,
  isPrEditable,
  lineAmount,
  lineRowsOf,
  purchaseRequestCapabilities,
  sumAmounts,
} from './purchase-request.rules';

const spec = WorkflowSpecSchema.parse(PURCHASE_REQUEST_WORKFLOW_SPEC);

const DEPT = '11111111-1111-4111-8111-111111111111';
const REQUESTER = 'user-requester';
const HEAD = 'user-head';
const OPS = 'user-ops';
const MGMT = 'user-mgmt';
const now = new Date('2026-11-09T04:00:00Z');

function plan(
  facts: Record<string, unknown>,
  data: { heads?: [string, string][]; roles?: Record<string, string[]> },
): RoutePlan {
  const directory: DirectoryData = {
    roleMembers: new Map(Object.entries(data.roles ?? {})),
    groups: new Map(),
    delegations: [],
    departmentHeads: new Map(data.heads ?? []),
  };
  const sod = [REQUESTER];
  return route(
    spec,
    facts,
    buildDirectory(directory, {
      now,
      documentType: PURCHASE_REQUEST_DOCUMENT_TYPE,
      sodUserIds: sod,
    }),
    sod,
  );
}

const facts = (over: Partial<{ isEmergency: boolean; departmentId: string }> = {}) =>
  approvalFactsOf({ departmentId: DEPT, isEmergency: false, amountNpr: '125000.00', ...over });

describe('the purchase_request route', () => {
  it('has the department head as its only step: no Accountant, no Finance (AD10)', () => {
    const p = plan(facts(), { heads: [[DEPT, HEAD]], roles: { operations_head: [OPS] } });
    expect(p.blocked).toBe(false);
    expect(p.steps).toHaveLength(1);
    const [step] = p.steps;
    expect(step).toMatchObject({ seq: 1, kind: 'department_head', userId: HEAD });
    expect(step!.eligibleUserIds).toEqual([HEAD]);
    // Nothing in the spec itself names the commitment route's roles, even as a rule.
    const roles = [...spec.steps, ...spec.rules.map((r) => r.add)].map((s) => s.role);
    expect(roles).not.toContain('accountant');
    expect(roles).not.toContain('finance');
  });

  it('does not change with the amount: a big estimate adds no step', () => {
    const p = plan(facts(), { heads: [[DEPT, HEAD]] });
    const big = plan(
      approvalFactsOf({ departmentId: DEPT, isEmergency: false, amountNpr: '99999999.00' }),
      { heads: [[DEPT, HEAD]] },
    );
    expect(big.steps.map((s) => s.kind)).toEqual(p.steps.map((s) => s.kind));
  });

  it('adds Management after the head for an emergency request (AD12)', () => {
    const p = plan(facts({ isEmergency: true }), {
      heads: [[DEPT, HEAD]],
      roles: { management: [MGMT] },
    });
    expect(p.blocked).toBe(false);
    expect(p.steps.map((s) => [s.kind, s.roleKey ?? s.userId])).toEqual([
      ['department_head', HEAD],
      ['role', 'management'],
    ]);
  });

  it('falls back to operations_head when the head is the requester (AD11)', () => {
    const p = plan(facts(), { heads: [[DEPT, REQUESTER]], roles: { operations_head: [OPS] } });
    expect(p.blocked).toBe(false);
    expect(p.steps[0]).toMatchObject({ kind: 'department_head', roleKey: 'operations_head' });
    expect(p.steps[0]!.eligibleUserIds).toEqual([OPS]);
  });

  it('falls back to operations_head when the department has no head (AD11)', () => {
    const p = plan(facts(), { roles: { operations_head: [OPS] } });
    expect(p.steps[0]).toMatchObject({ roleKey: 'operations_head' });
    expect(p.steps[0]!.eligibleUserIds).toEqual([OPS]);
  });

  it('is blocked when there is no head and no operations_head', () => {
    const p = plan(facts(), {});
    expect(p.blocked).toBe(true);
    expect(p.steps[0]!.eligibleUserIds).toEqual([]);
  });

  it('is blocked when the only operations_head is the requester', () => {
    const p = plan(facts(), { roles: { operations_head: [REQUESTER] } });
    expect(p.blocked).toBe(true);
  });
});

describe('line arithmetic', () => {
  it('preserves the serial requirement from the request body for issued goods', () => {
    const input = { description: 'Laptop', uom: 'pcs', quantity: '2', estimatedUnitPrice: '50000' };
    const required = PurchaseRequestLineBodySchema.parse({ ...input, requiresSerials: true });
    expect(lineRowsOf([required], 'goods')[0]).toMatchObject({ requiresSerials: true });
    const ordinary = PurchaseRequestLineBodySchema.parse(input);
    expect(lineRowsOf([ordinary], 'goods')[0]).toMatchObject({ requiresSerials: false });
  });

  it('refuses serial tracking on any service line with a 422 serials_not_allowed', () => {
    const ordinary = {
      description: 'Support',
      uom: 'hours',
      quantity: '2',
      estimatedUnitPrice: '500',
    };
    try {
      lineRowsOf([ordinary, { ...ordinary, requiresSerials: true }], 'service');
      expect.fail('A service request must not require serial numbers');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).getStatus()).toBe(422);
      expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
        code: 'serials_not_allowed',
      });
    }
  });

  it.each([undefined, false])(
    'allows a service line with requiresSerials=%s',
    (requiresSerials) => {
      const line = PurchaseRequestLineBodySchema.parse({
        description: 'Support',
        uom: 'hours',
        quantity: '2',
        estimatedUnitPrice: '500',
        requiresSerials,
      });
      expect(lineRowsOf([line], 'service')[0]).toMatchObject({ requiresSerials: false });
    },
  );

  it('rounds a line half up to 2 places and sums exactly', () => {
    expect(lineAmount('3', '0.10')).toBe('0.30');
    expect(lineAmount('0.3333', '1.50')).toBe('0.50');
    expect(lineAmount('1.0050', '1.00')).toBe('1.01');
    expect(lineAmount('2', '1234567.89')).toBe('2469135.78');
    expect(sumAmounts(['0.10', '0.20', '0.30'])).toBe('0.60');
    expect(sumAmounts([])).toBe('0.00');
  });

  it('numbers lines from 1 in body order and never trusts a client amount', () => {
    const rows = lineRowsOf(
      [
        { description: 'Chairs', uom: 'pcs', quantity: '10', estimatedUnitPrice: '4500.00' },
        {
          description: 'Desk',
          specification: 'Oak',
          uom: 'pcs',
          quantity: '2.5',
          estimatedUnitPrice: '100.10',
        },
      ],
      'goods',
    );
    expect(rows.map((r) => [r.lineNo, r.specification, r.estimatedAmount])).toEqual([
      [1, null, '45000.00'],
      [2, 'Oak', '250.25'],
    ]);
  });
});

describe('approval facts and statuses', () => {
  it('carries exactly departmentId, isEmergency and the NPR estimate', () => {
    expect(facts({ isEmergency: true })).toEqual({
      departmentId: DEPT,
      isEmergency: true,
      amountNpr: '125000.00',
    });
  });

  it('maps a decision to the status of the PR_TRANSITIONS table', () => {
    expect(PR_STATUS_AFTER_DECISION).toEqual({
      approved: 'dept_approved',
      returned: 'returned',
      rejected: 'rejected',
    });
  });

  it('allows edits in draft and returned only', () => {
    expect(['draft', 'returned'].every(isPrEditable)).toBe(true);
    for (const s of ['submitted', 'dept_approved', 'rejected', 'cancelled', 'sourcing']) {
      expect(isPrEditable(s)).toBe(false);
    }
  });

  it('reads expectedVersion off a body and refuses a bad one', () => {
    expect(ExpectedVersionEnvelopeSchema.parse({ a: 1, expectedVersion: 3 })).toMatchObject({
      expectedVersion: 3,
    });
    expect(ExpectedVersionEnvelopeSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(ExpectedVersionEnvelopeSchema.safeParse({ expectedVersion: '2' }).success).toBe(false);
    expect(ExpectedVersionEnvelopeSchema.safeParse('x').success).toBe(false);
  });
});

describe('the list query', () => {
  it('takes a repeated status, a search, a limit and an offset', () => {
    expect(ListPurchaseRequestsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(
      ListPurchaseRequestsQuerySchema.parse({
        status: ['draft', 'submitted', 'draft'],
        q: ' chairs ',
        limit: '200',
        offset: '400',
      }),
    ).toEqual({ status: ['draft', 'submitted'], q: 'chairs', limit: 200, offset: 400 });
    expect(ListPurchaseRequestsQuerySchema.parse({ status: 'cancelled' }).status).toEqual([
      'cancelled',
    ]);
  });

  it('refuses an unknown status, a limit over 200 and an unknown key', () => {
    expect(ListPurchaseRequestsQuerySchema.safeParse({ status: ['draft', 'nope'] }).success).toBe(
      false,
    );
    expect(ListPurchaseRequestsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(ListPurchaseRequestsQuerySchema.safeParse({ organizationId: 'x' }).success).toBe(false);
  });
});

describe('purchaseRequestCapabilities', () => {
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const ENTITY = '00000000-0000-4000-8000-000000000002';
  const ME = '00000000-0000-4000-8000-000000000003';
  const OTHER = '00000000-0000-4000-8000-000000000004';
  const RFQ = '00000000-0000-4000-8000-000000000099';

  function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
    return {
      userId: ME,
      zitadelUserId: 'z-me',
      tenantId: TENANT,
      organizationId: ENTITY,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: '00000000-0000-4000-8000-000000000009',
      roles: [role],
      departmentId: DEPT,
      status: 'active',
      grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
      ...over,
    };
  }

  const pr = (status: PrStatus, requesterUserId = ME) => ({
    tenantId: TENANT,
    organizationId: ENTITY,
    requesterUserId,
    departmentId: DEPT,
    status,
  });

  it('grants edit/submit/cancel on own draft and denies on another requester under own scope', () => {
    const officer = principalOf('operations_officer');
    expect(purchaseRequestCapabilities(officer, pr('draft', ME), null)).toEqual({
      edit: true,
      submit: true,
      cancel: true,
      startRfq: false,
      openRfq: false,
    });
    expect(purchaseRequestCapabilities(officer, pr('returned', ME), null)).toEqual({
      edit: true,
      submit: true,
      cancel: false,
      startRfq: false,
      openRfq: false,
    });
    expect(purchaseRequestCapabilities(officer, pr('draft', OTHER), null)).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: false,
      openRfq: false,
    });
  });

  it('grants startRfq and openRfq only to holders of procurement.sourcing', () => {
    const procurement = principalOf('procurement');
    expect(purchaseRequestCapabilities(procurement, pr('dept_approved', OTHER), null)).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: true,
      openRfq: false,
    });
    expect(purchaseRequestCapabilities(procurement, pr('sourcing', OTHER), RFQ)).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: false,
      openRfq: true,
    });
    // A regular requester cannot start or open an RFQ even on their own approved request.
    const officer = principalOf('operations_officer');
    expect(purchaseRequestCapabilities(officer, pr('dept_approved', ME), null)).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: false,
      openRfq: false,
    });
    expect(purchaseRequestCapabilities(officer, pr('sourcing', ME), RFQ).openRfq).toBe(false);

    // A buyer with department-scoped sourcing still matches SourcingController's route-level check.
    const deptBuyer = principalOf('procurement', {
      departmentId: '00000000-0000-4000-8000-000000000099',
      grants: new Map([['procurement.sourcing', 'department']]),
    });
    expect(purchaseRequestCapabilities(deptBuyer, pr('dept_approved', OTHER), null).startRfq).toBe(
      true,
    );
    expect(purchaseRequestCapabilities(deptBuyer, pr('sourcing', OTHER), RFQ).openRfq).toBe(true);
  });

  it('denies everything for an inactive or non-staff principal', () => {
    expect(
      purchaseRequestCapabilities(
        principalOf('founder', { status: 'inactive' }),
        pr('draft', ME),
        null,
      ),
    ).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: false,
      openRfq: false,
    });
    expect(
      purchaseRequestCapabilities(
        principalOf('founder', { orgKind: 'vendor' }),
        pr('dept_approved', ME),
        null,
      ),
    ).toEqual({
      edit: false,
      submit: false,
      cancel: false,
      startRfq: false,
      openRfq: false,
    });
  });
});
