// Unit tests of the approval snapshot output filter (D29): a quotation snapshot loses `marginPct` (the key is ABSENT,
// never null) unless the viewer's live grants hold `quotation.cost.read`; other document types and the stored
// snapshot are never touched. Pure: no database, no clock.
import type { ApprovalRequestDto, Permission, Scope } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { requestVisibleTo, withoutCostKeys } from './snapshot-visibility';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function principal(granted: Permission[], over: Partial<Principal> = {}): Principal {
  return {
    userId: id(3),
    zitadelUserId: 'z-me',
    tenantId: id(1),
    organizationId: id(2),
    orgKind: 'staff',
    partyId: null,
    idpOrgId: id(9),
    roles: ['sales'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>(granted.map((p) => [p, 'all'])),
    ...over,
  };
}

const withCost = principal(['approvals.requests.read', 'quotation.cost.read']);
const withoutCost = principal(['approvals.requests.read']);

const SNAPSHOT = {
  nprTotal: '2690999.99',
  effectiveDiscountPct: '13.0000',
  marginPct: '21.5000',
  nprDiscountAmount: '402500.00',
  currency: 'NPR',
  fxRate: '1',
  customerName: 'Himal Traders',
  quotationNumber: 'QT-2082/83-00001',
  revisionNo: 1,
  discountApprovalRequired: true,
};

function request(over: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    requestId: id(10),
    documentType: 'quotation_version',
    documentId: id(11),
    documentNumber: 'QT-2082/83-00001',
    status: 'pending',
    blockReason: null,
    currentSeq: 1,
    version: 1,
    requesterUserId: id(4),
    snapshot: SNAPSHOT,
    steps: [],
    actions: [],
    submittedAt: '2026-11-08T04:00:00.000Z',
    decidedAt: null,
    ...over,
  };
}

describe('withoutCostKeys', () => {
  it('drops marginPct and internalCostTotal from a quotation snapshot and keeps every other key', () => {
    const { marginPct: _margin, ...expected } = SNAPSHOT;
    const out = withoutCostKeys('quotation_version', { ...SNAPSHOT, internalCostTotal: '100.00' });
    expect(out).toEqual(expected);
    expect(Object.keys(out as object)).not.toContain('marginPct');
    expect(Object.keys(out as object)).not.toContain('internalCostTotal');
  });

  it('drops a null marginPct too: the key is absent, not null', () => {
    const out = withoutCostKeys('quotation_version', { ...SNAPSHOT, marginPct: null });
    expect('marginPct' in (out as object)).toBe(false);
  });

  it('returns the same value when there is nothing to drop', () => {
    const { marginPct: _margin, ...bare } = SNAPSHOT;
    expect(withoutCostKeys('quotation_version', bare)).toBe(bare);
  });

  it('leaves another document type alone, even one that has a marginPct key', () => {
    const memo = { title: 'Chairs', marginPct: '5.0000' };
    expect(withoutCostKeys('test_memo', memo)).toBe(memo);
  });

  it.each([null, undefined, 'text', 7, ['marginPct']])(
    'passes a non-object snapshot through (%s)',
    (v) => {
      expect(withoutCostKeys('quotation_version', v)).toBe(v);
    },
  );

  it('does not change its input', () => {
    const input = { ...SNAPSHOT };
    withoutCostKeys('quotation_version', input);
    expect(input).toEqual(SNAPSHOT);
  });
});

describe('requestVisibleTo', () => {
  it('shows the full snapshot to a viewer holding quotation.cost.read', () => {
    const r = request();
    expect(requestVisibleTo(withCost, r)).toBe(r);
    expect((requestVisibleTo(withCost, r).snapshot as typeof SNAPSHOT).marginPct).toBe('21.5000');
  });

  it('omits marginPct for a viewer without quotation.cost.read, and changes nothing else', () => {
    const r = request();
    const out = requestVisibleTo(withoutCost, r);
    const { marginPct: _margin, ...rest } = SNAPSHOT;
    expect(out.snapshot).toEqual(rest);
    expect({ ...out, snapshot: null }).toEqual({ ...r, snapshot: null });
  });

  it('does not mutate the request it was given, so the stored result keeps its hash', () => {
    const r = request();
    const before = canonicalSha256(r.snapshot);
    requestVisibleTo(withoutCost, r);
    expect(canonicalSha256(r.snapshot)).toEqual(before);
    expect((r.snapshot as typeof SNAPSHOT).marginPct).toBe('21.5000');
  });

  it('follows the live grants, not the role name: a viewer whose role lost the key sees no margin', () => {
    expect(requestVisibleTo(withoutCost, request()).snapshot).not.toHaveProperty('marginPct');
    expect(requestVisibleTo(withCost, request()).snapshot).toHaveProperty('marginPct');
  });

  it('refuses a portal caller even if a role row names the key', () => {
    const portal = principal(['quotation.cost.read'], { orgKind: 'customer', partyId: id(20) });
    expect(requestVisibleTo(portal, request()).snapshot).not.toHaveProperty('marginPct');
  });

  it('leaves another document type unchanged for a viewer without the key', () => {
    const memo = request({ documentType: 'test_memo', snapshot: { title: 'Chairs' } });
    expect(requestVisibleTo(withoutCost, memo)).toBe(memo);
  });
});
