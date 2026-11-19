// Unit tests of the cost-visibility helpers (D29b): who may read cost figures, the output filter that drops them
// (keys ABSENT, never null or undefined), and the unit costs a draft save may write. Pure: no database, no clock.
import {
  DEFAULT_ROLE_PERMISSIONS,
  QuotationVersionDtoSchema,
  type Permission,
  type QuotationDetail,
  type QuotationVersionDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { PricingInput } from '../pricing/pricing.types';
import {
  canReadCost,
  detailVisibleTo,
  pricingWithAllowedCosts,
  versionVisibleTo,
  withoutCostFigures,
  type StoredCostLine,
} from './cost-visibility';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
  return {
    userId: id(3),
    zitadelUserId: 'z-me',
    tenantId: id(1),
    organizationId: id(2),
    orgKind: 'staff',
    partyId: null,
    idpOrgId: id(9),
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
    ...over,
  };
}

/** `p` with `quotation.cost.read` taken out of (or put into) its live grants, as an edited role would. */
function withCostGrant(p: Principal, granted: boolean): Principal {
  const grants = new Map(p.grants);
  if (granted) grants.set('quotation.cost.read', 'all');
  else grants.delete('quotation.cost.read');
  return { ...p, grants };
}

const line = (lineNo: number, unitCost: string | null) => ({
  lineNo,
  catalogItemId: null,
  description: `Line ${lineNo}`,
  uom: 'lot',
  quantity: '1',
  unitPrice: '100.00',
  unitCost,
  taxCodeId: id(30),
  gross: '100.00',
  discountAlloc: '0.00',
  taxable: '100.00',
});

/** A full version DTO as toQuotationVersionDto builds it: the cost figures present, one of them null. */
const fullVersion = (versionId = id(11)): QuotationVersionDto =>
  QuotationVersionDtoSchema.parse({
    id: versionId,
    quotationId: id(10),
    number: 'QT-2082/83-00042',
    revisionNo: 1,
    status: 'draft',
    rejectionSource: null,
    customerId: id(20),
    contactId: null,
    templateId: null,
    currency: 'NPR',
    issueDate: '2026-11-09',
    validUntil: '2026-11-30',
    scope: null,
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: null,
    paymentTermId: null,
    paymentSchedule: [],
    discount: null,
    lines: [line(1, '40.00'), line(2, null)],
    taxSummary: [],
    totals: {
      subtotal: '200.00',
      discountAmount: '0.00',
      taxableAmount: '200.00',
      taxAmount: '26.00',
      total: '226.00',
      effectiveDiscountPct: '0.0000',
    },
    internalCostTotal: '40.00',
    marginPct: '80.0000',
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderedScanStatus: null,
    supersedesVersionId: null,
    supersededByVersionId: null,
    revisionReason: null,
    cancelReason: null,
    submittedAt: null,
    approvedAt: null,
    sentAt: null,
    acceptedAt: null,
    rejectedAt: null,
    expiredAt: null,
    cancelledAt: null,
    version: 1,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
  });

describe('canReadCost', () => {
  it('is true for an active staff user whose live grants hold quotation.cost.read', () => {
    expect(canReadCost(principalOf('sales'))).toBe(true);
    expect(canReadCost(principalOf('founder'))).toBe(true);
  });

  it('is false for a role without the grant, and follows an edited grant set, not the role name', () => {
    expect(canReadCost(principalOf('operations_head'))).toBe(false);
    expect(canReadCost(withCostGrant(principalOf('sales'), false))).toBe(false);
    expect(canReadCost(withCostGrant(principalOf('operations_head'), true))).toBe(true);
  });

  it('is false for an inactive or invited user even with the grant', () => {
    expect(canReadCost(principalOf('sales', { status: 'inactive' }))).toBe(false);
    expect(canReadCost(principalOf('sales', { status: 'invited' }))).toBe(false);
  });

  it('is false for a portal caller even when a role row names the key by mistake', () => {
    const grants = new Map<Permission, Scope>([['quotation.cost.read', 'all']]);
    expect(canReadCost(principalOf('sales', { orgKind: 'customer', grants }))).toBe(false);
    expect(canReadCost(principalOf('sales', { orgKind: 'vendor', grants }))).toBe(false);
  });

  it('is false for a scope value this code does not know', () => {
    const grants = new Map([['quotation.cost.read', 'galaxy']]) as unknown as Map<
      Permission,
      Scope
    >;
    expect(canReadCost(principalOf('sales', { grants }))).toBe(false);
  });
});

describe('withoutCostFigures', () => {
  it('omits internalCostTotal, marginPct and every unitCost: the keys are absent, not null', () => {
    const dto = withoutCostFigures(fullVersion());
    expect('internalCostTotal' in dto).toBe(false);
    expect('marginPct' in dto).toBe(false);
    for (const l of dto.lines) expect('unitCost' in l).toBe(false);
    // A line that had no cost (null) is hidden too: absent must not reveal which lines have one.
    expect(dto.lines).toHaveLength(2);
    expect(JSON.stringify(dto)).not.toMatch(
      /unitCost|internalCostTotal|marginPct|40\.00"|80\.0000/,
    );
  });

  it('keeps every other field and still parses with the contract', () => {
    const full = fullVersion();
    const dto = withoutCostFigures(full);
    expect(QuotationVersionDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.totals).toEqual(full.totals);
    expect(dto.lines.map((l) => [l.lineNo, l.unitPrice, l.gross])).toEqual(
      full.lines.map((l) => [l.lineNo, l.unitPrice, l.gross]),
    );
    expect(dto).toMatchObject({ id: full.id, number: full.number, status: 'draft', version: 1 });
  });

  it('does not mutate its input: the full DTO (the draft merge base) keeps its costs', () => {
    const full = fullVersion();
    withoutCostFigures(full);
    expect(full.internalCostTotal).toBe('40.00');
    expect(full.marginPct).toBe('80.0000');
    expect(full.lines[0]!.unitCost).toBe('40.00');
  });
});

describe('versionVisibleTo', () => {
  it('returns the figures for a permitted caller and strips them otherwise', () => {
    const full = fullVersion();
    expect(versionVisibleTo(principalOf('sales'), full)).toBe(full);
    const hidden = versionVisibleTo(withCostGrant(principalOf('sales'), false), full);
    expect('marginPct' in hidden).toBe(false);
    expect(versionVisibleTo(principalOf('sales', { status: 'inactive' }), full)).toEqual(
      withoutCostFigures(full),
    );
  });
});

describe('detailVisibleTo', () => {
  const detail = (): QuotationDetail =>
    ({
      quotation: {},
      versions: [fullVersion(id(11)), fullVersion(id(12))],
      statusHistory: [],
      customerName: 'Acme',
      contacts: [],
      capabilities: { canEdit: true, canRevise: false },
      lead: { id: id(40), name: 'Website enquiry' },
    }) as unknown as QuotationDetail;

  it('strips every version, Superseded included, and leaves the rest of the answer alone', () => {
    const out = detailVisibleTo(principalOf('operations_head'), detail());
    expect(out.versions).toHaveLength(2);
    for (const v of out.versions) {
      expect('internalCostTotal' in v).toBe(false);
      expect('marginPct' in v).toBe(false);
      for (const l of v.lines) expect('unitCost' in l).toBe(false);
    }
    expect(out.customerName).toBe('Acme');
    expect(out.capabilities).toEqual({ canEdit: true, canRevise: false });
    // The lead (D35) is not a cost figure: stripping costs keeps it.
    expect(out.lead).toEqual({ id: id(40), name: 'Website enquiry' });
    // The schema accepts the stripped shape.
    expect(QuotationVersionDtoSchema.array().parse(out.versions)).toHaveLength(2);
  });

  it('returns the detail untouched for a permitted caller', () => {
    const d = detail();
    expect(detailVisibleTo(principalOf('finance'), d)).toBe(d);
  });
});

describe('pricingWithAllowedCosts', () => {
  const input = (costs: (string | null | undefined)[]): PricingInput => ({
    currency: 'NPR',
    issueDate: '2026-11-09',
    discount: null,
    lines: costs.map((c, i) => ({
      lineNo: i + 1,
      catalogItemId: null,
      description: `Line ${i + 1}`,
      uom: 'lot',
      quantity: '1',
      unitPrice: '100.00',
      taxCodeId: id(30),
      ...(c === undefined ? {} : { unitCost: c }),
    })),
  });
  // The stored lines, in line order: the same identities as `input` builds, with their stored costs.
  const stored: StoredCostLine[] = [
    { catalogItemId: null, description: 'Line 1', uom: 'lot', unitCost: '40.00' },
    { catalogItemId: null, description: 'Line 2', uom: 'lot', unitCost: null },
    { catalogItemId: null, description: 'Line 3', uom: 'lot', unitCost: '7.50' },
  ];

  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error as ConflictException;
    }
    throw new Error('expected a refusal');
  };

  it('passes the input through for a caller who may read costs (an omitted cost clears it, as before)', () => {
    const body = input(['1.00', undefined, '2.00']);
    expect(pricingWithAllowedCosts(body, true, stored)).toBe(body);
    // Adding a line is fine with the permission.
    expect(() => pricingWithAllowedCosts(input(['1.00']), true, stored)).not.toThrow();
  });

  it('gives each line the stored cost of its position, whatever the body says', () => {
    const out = pricingWithAllowedCosts(input([undefined, '999.00', '1.00']), false, stored);
    expect(out.lines.map((l) => l.unitCost)).toEqual(['40.00', null, '7.50']);
  });

  it('gives every line no cost on create (nothing stored, nothing refused)', () => {
    expect(
      pricingWithAllowedCosts(input(['5.00', '6.00']), false, []).lines.map((l) => l.unitCost),
    ).toEqual([null, null]);
  });

  it('refuses a removed line before any cost moves onto another line', () => {
    const body = input([undefined, undefined]); // line 1 deleted: Line 1 / Line 3 would be renumbered 1 / 2
    body.lines[0]!.description = 'Line 2';
    body.lines[1]!.description = 'Line 3';
    const error = refusal(() => pricingWithAllowedCosts(body, false, stored));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'cost_figures_restricted',
      message:
        'Lines cannot be added, removed or reordered on a quotation whose cost figures you cannot see',
    });
  });

  it('refuses an inserted line, an appended line and a reorder', () => {
    const inserted = input([undefined, undefined, undefined, undefined]);
    inserted.lines[1]!.description = 'New';
    inserted.lines[2]!.description = 'Line 2';
    inserted.lines[3]!.description = 'Line 3';
    expect(() => pricingWithAllowedCosts(inserted, false, stored)).toThrow(ConflictException);
    expect(() =>
      pricingWithAllowedCosts(input([undefined, undefined, undefined, '5.00']), false, stored),
    ).toThrow(ConflictException);
    const reordered = input([undefined, undefined, undefined]);
    reordered.lines[0]!.description = 'Line 2';
    reordered.lines[1]!.description = 'Line 1';
    expect(() => pricingWithAllowedCosts(reordered, false, stored)).toThrow(ConflictException);
  });

  it('refuses an identity edit (catalog item, description or unit of measure) of a stored line', () => {
    for (const edit of [{ catalogItemId: id(50) }, { description: 'Renamed' }, { uom: 'month' }]) {
      const body = input([undefined, undefined, undefined]);
      Object.assign(body.lines[1]!, edit);
      expect(() => pricingWithAllowedCosts(body, false, stored), JSON.stringify(edit)).toThrow(
        ConflictException,
      );
    }
  });

  it('allows quantity, unit price and tax code edits, and treats a missing catalog item as null', () => {
    const body = input([undefined, undefined, undefined]);
    for (const line of body.lines) {
      line.quantity = '9';
      line.unitPrice = '1.00';
      line.taxCodeId = id(31);
      delete line.catalogItemId;
    }
    const out = pricingWithAllowedCosts(body, false, stored);
    expect(out.lines.map((l) => [l.quantity, l.unitCost])).toEqual([
      ['9', '40.00'],
      ['9', null],
      ['9', '7.50'],
    ]);
  });

  it('changes nothing but the costs and does not mutate its input', () => {
    const body = input([undefined, undefined, undefined]);
    const out = pricingWithAllowedCosts(body, false, stored);
    expect(out).toMatchObject({ currency: 'NPR', issueDate: '2026-11-09', discount: null });
    expect(out.lines.map((l) => l.description)).toEqual(['Line 1', 'Line 2', 'Line 3']);
    expect(body.lines.every((l) => !('unitCost' in l))).toBe(true);
  });
});
