// Unit tests of the cost-figure filter on GET /v1/audit (D29): the real AuditController answers a page whose rows are
// shaped as the audit_capture trigger writes them (to_jsonb of the row, snake_case columns, entity type = table name).
// A caller without `quotation.cost.read` keeps every row but loses unit_cost, internal_cost_total, margin_pct and a
// quotation approval snapshot's marginPct, with the canonical text of those sides withheld. Fakes, no database.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.cost-redaction.test.ts
import {
  type AuditEventDto,
  AuditEventDtoSchema,
  type Permission,
  type Scope,
} from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../authz/principal';
import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caller = { tenantId: id(1), organizationId: id(2) };

let principal: Principal | undefined;
vi.mock('../tenancy/request-context', () => ({
  ctx: () => caller,
  currentPrincipal: () => principal,
}));

function staff(granted: Permission[], over: Partial<Principal> = {}): Principal {
  return {
    userId: id(3),
    zitadelUserId: 'z-me',
    tenantId: id(1),
    organizationId: id(2),
    orgKind: 'staff',
    partyId: null,
    idpOrgId: id(9),
    roles: ['finance'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>(granted.map((p) => [p, 'all'])),
    ...over,
  };
}

let seq = 0;
/** An event as AuditService.list returns it, with canonical text the way Postgres prints the jsonb. */
function event(entityType: string, before: unknown, after: unknown): AuditEventDto {
  seq += 1;
  const text = (v: unknown) => (v === null ? null : JSON.stringify(v));
  return AuditEventDtoSchema.parse({
    id: String(seq),
    tenantId: caller.tenantId,
    organizationId: caller.organizationId,
    chainMonth: '2026-11-01',
    seq,
    occurredAt: '2026-11-19T10:00:00.000000Z',
    actorKind: 'user',
    actorId: id(3),
    actorDisplayName: 'Asha',
    action: `${entityType}.${before === null ? 'insert' : 'update'}`,
    entityType,
    entityId: id(100 + seq),
    before,
    after,
    meta: null,
    canonical: { before: text(before), after: text(after), meta: null },
    ip: null,
    userAgent: null,
    correlationId: 'corr-1',
    prevHash: '00'.repeat(32),
    hash: 'ab'.repeat(32),
  });
}

const lineBefore = {
  id: id(50),
  line_no: 1,
  description: 'Router',
  unit_price: '1000.00',
  unit_cost: '700.00',
};
const lineAfter = { ...lineBefore, unit_price: '1100.00', unit_cost: '720.00' };
const versionAfter = {
  id: id(60),
  total: '2240.00',
  internal_cost_total: '1440.00',
  margin_pct: '35.7143',
};
const requestAfter = {
  id: id(70),
  document_type: 'quotation_version',
  status: 'pending',
  snapshot: {
    nprTotal: '2240.00',
    marginPct: '35.7143',
    currency: 'NPR',
    customerName: 'Himal Traders',
  },
};
const memoAfter = { id: id(80), document_type: 'memo', snapshot: { marginPct: 'not a quotation' } };

const fakeAudit = { list: vi.fn(), verifyChain: vi.fn() };
let controller: AuditController;

function page() {
  seq = 0;
  return [
    event('quotation_lines', lineBefore, lineAfter),
    event('quotation_versions', null, versionAfter),
    event('approval_requests', null, requestAfter),
    event('approval_requests', null, memoAfter),
    event('quotations', null, { number: 'Q-1', total: '2240.00' }),
  ];
}

beforeEach(() => {
  vi.resetAllMocks();
  fakeAudit.list.mockResolvedValue(page());
  controller = new AuditController(fakeAudit as unknown as AuditService);
});

describe('GET /v1/audit cost figures (D29)', () => {
  it('serves every figure, and the canonical text, to a reader holding quotation.cost.read', async () => {
    principal = staff(['audit.read', 'quotation.cost.read']);
    const { items } = await controller.list({});
    expect(items).toEqual(page());
  });

  it('keeps every row but removes the cost keys for a reader without quotation.cost.read', async () => {
    principal = staff(['audit.read']);
    const { items } = await controller.list({});
    expect(items).toHaveLength(5);
    const [line, version, request, memo, quotation] = items;

    expect(line!.before).not.toHaveProperty('unit_cost');
    expect(line!.after).not.toHaveProperty('unit_cost');
    expect(line!.after).toMatchObject({ unit_price: '1100.00', description: 'Router' });
    expect(line!.canonical).toEqual({ before: null, after: null, meta: null });
    expect(JSON.stringify(line)).not.toContain('700.00');
    expect(JSON.stringify(line)).not.toContain('720.00');

    expect(version!.after).not.toHaveProperty('internal_cost_total');
    expect(version!.after).not.toHaveProperty('margin_pct');
    expect(version!.after).toMatchObject({ total: '2240.00' });
    expect(version!.before).toBeNull();
    expect(version!.canonical.after).toBeNull();
    expect(JSON.stringify(version)).not.toContain('35.7143');

    expect(request!.after).toMatchObject({ status: 'pending', snapshot: { nprTotal: '2240.00' } });
    expect((request!.after as typeof requestAfter).snapshot).not.toHaveProperty('marginPct');
    expect(JSON.stringify(request)).not.toContain('35.7143');

    // Another document type's snapshot and a row without cost columns are served as stored.
    expect(memo).toEqual(page()[3]);
    expect(quotation).toEqual(page()[4]);
  });

  it('removes the figures for a portal caller even if a role row grants the key, and for a missing principal', async () => {
    principal = staff(['audit.read', 'quotation.cost.read'], {
      orgKind: 'customer',
      partyId: id(20),
    });
    expect(JSON.stringify((await controller.list({})).items)).not.toContain('35.7143');
    principal = undefined;
    expect(JSON.stringify((await controller.list({})).items)).not.toContain('720.00');
  });

  it('removes the figures for an inactive user who still holds the grant', async () => {
    principal = staff(['audit.read', 'quotation.cost.read'], { status: 'inactive' });
    expect(JSON.stringify((await controller.list({})).items)).not.toContain('720.00');
  });
});
