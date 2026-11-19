// Unit tests of the row-to-DTO mapping of quotations (no database). The point is the boundary: every DTO the
// mapping builds from a row shaped like the schema's must parse with the contract schema the web app trusts,
// money stays a string, and a bytea hash leaves as lower-case hex.
import {
  QuotationDetailSchema,
  QuotationDtoSchema,
  QuotationListItemSchema,
  QuotationVersionDtoSchema,
} from '@bos/contracts';
import type {
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
} from '@bos/db';
import { describe, expect, it } from 'vitest';

import {
  toQuotationDetail,
  toQuotationDto,
  toQuotationListItem,
  toQuotationVersionDto,
} from './mapping';

type QuotationRow = typeof quotations.$inferSelect;
type VersionRow = typeof quotationVersions.$inferSelect;
type LineRow = typeof quotationLines.$inferSelect;
type TaxRow = typeof quotationTaxSummary.$inferSelect;
type HistoryRow = typeof quotationStatusHistory.$inferSelect;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const QUOTATION = id(10);
const VERSION_1 = id(11);
const VERSION_2 = id(12);
const CUSTOMER = id(20);
const TAX_VAT = id(30);
const T0 = new Date('2026-11-01T08:00:00.000Z');
const T1 = new Date('2026-11-02T09:30:00.000Z');

const quotation = (over: Partial<QuotationRow> = {}): QuotationRow => ({
  id: QUOTATION,
  tenantId: TENANT,
  organizationId: ORG,
  number: 'QT-2026-0042',
  customerPartyId: CUSTOMER,
  customerPartyKind: 'customer',
  opportunityId: id(40),
  currentVersionId: VERSION_2,
  ownerUserId: id(50),
  legacySource: null,
  version: 3,
  createdAt: T0,
  updatedAt: T1,
  ...over,
});

const version = (over: Partial<VersionRow> = {}): VersionRow => ({
  id: VERSION_1,
  tenantId: TENANT,
  organizationId: ORG,
  quotationId: QUOTATION,
  revisionNo: 1,
  status: 'draft',
  rejectionSource: null,
  contactId: null,
  templateId: null,
  currency: 'NPR',
  issueDate: '2026-11-01',
  validUntil: '2026-11-30',
  scope: null,
  assumptions: null,
  exclusions: null,
  termsAndConditions: null,
  deliveryTimeline: null,
  paymentTermId: null,
  paymentSchedule: [],
  discountMode: null,
  discountInput: null,
  subtotal: '1000.00',
  discountAmount: '0.00',
  taxableAmount: '1000.00',
  taxAmount: '130.00',
  total: '1130.00',
  effectiveDiscountPct: '0.0000',
  fxRate: null,
  fxSource: null,
  fxDate: null,
  amountNpr: null,
  nprTaxableAmount: null,
  internalCostTotal: null,
  marginPct: null,
  calcVersion: 1,
  contentSha256: null,
  snapshotSha256: null,
  approvalRequestId: null,
  renderedDocumentId: null,
  renderedSha256: null,
  renderState: 'none',
  documentStyle: null,
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
  createdAt: T0,
  updatedAt: T1,
  ...over,
});

const line = (lineNo: number, over: Partial<LineRow> = {}): LineRow => ({
  id: id(100 + lineNo),
  tenantId: TENANT,
  organizationId: ORG,
  versionId: VERSION_1,
  lineNo,
  catalogItemId: null,
  description: `Item ${lineNo}`,
  uom: 'pcs',
  quantity: '2.0000',
  unitPrice: '500.00',
  unitCost: null,
  taxCodeId: TAX_VAT,
  gross: '1000.00',
  discountAlloc: '0.00',
  taxable: '1000.00',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const tax = (over: Partial<TaxRow> = {}): TaxRow => ({
  id: id(200),
  tenantId: TENANT,
  organizationId: ORG,
  versionId: VERSION_1,
  taxCodeId: TAX_VAT,
  label: 'VAT 13%',
  rate: '13.0000',
  base: '1000.00',
  tax: '130.00',
  createdAt: T0,
  ...over,
});

const history = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  id: id(300),
  tenantId: TENANT,
  organizationId: ORG,
  versionId: VERSION_1,
  fromStatus: null,
  toStatus: 'draft',
  actorId: id(50),
  reason: null,
  at: T0,
  ...over,
});

const HASH_A = Buffer.alloc(32, 0xab);
const HASH_B = Buffer.from('00ff'.repeat(16), 'hex');

/** A sent USD version with everything the submit step freezes: the hardest shape to map. */
const sentUsd = (): VersionRow =>
  version({
    id: VERSION_2,
    revisionNo: 2,
    status: 'sent',
    currency: 'USD',
    supersedesVersionId: VERSION_1,
    revisionReason: 'Customer asked for a lower price',
    contactId: id(60),
    paymentSchedule: [{ label: 'Advance', percent: '50', dueDescription: 'On order' }],
    discountMode: 'pct',
    discountInput: '10.0000',
    subtotal: '1000.00',
    discountAmount: '100.00',
    taxableAmount: '900.00',
    taxAmount: '117.00',
    total: '1017.00',
    effectiveDiscountPct: '10.0000',
    fxRate: '133.450000',
    fxSource: 'NRB',
    fxDate: '2026-11-02',
    amountNpr: '135715.65',
    nprTaxableAmount: '120105.00',
    internalCostTotal: '600.00',
    marginPct: '33.3333',
    contentSha256: HASH_A,
    snapshotSha256: HASH_B,
    approvalRequestId: id(70),
    renderedDocumentId: id(80),
    renderedSha256: HASH_A,
    renderState: 'rendered',
    submittedAt: T0,
    approvedAt: T1,
    sentAt: T1,
    version: 5,
  });

const draftParts = (over: Partial<Parameters<typeof toQuotationVersionDto>[0]> = {}) => ({
  quotation: quotation(),
  version: version(),
  lines: [line(1)],
  taxSummary: [tax()],
  renderedScanStatus: null,
  ...over,
});

describe('toQuotationVersionDto', () => {
  it('maps a draft NPR version that parses with the contract schema', () => {
    const dto = toQuotationVersionDto(draftParts());
    expect(QuotationVersionDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({
      id: VERSION_1,
      quotationId: QUOTATION,
      number: 'QT-2026-0042',
      customerId: CUSTOMER,
      status: 'draft',
      discount: null,
      nprSnapshot: null,
      snapshotSha256: null,
      renderedSha256: null,
      renderedScanStatus: null,
      createdAt: '2026-11-01T08:00:00.000Z',
      submittedAt: null,
    });
  });

  it('carries the terms and conditions, and null when there are none', () => {
    expect(toQuotationVersionDto(draftParts()).termsAndConditions).toBeNull();
    const dto = toQuotationVersionDto(
      draftParts({ version: version({ termsAndConditions: 'Payment within 30 days.' }) }),
    );
    expect(dto.termsAndConditions).toBe('Payment within 30 days.');
    expect(QuotationVersionDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('keeps money, quantities and percentages as the strings the database returned', () => {
    const dto = toQuotationVersionDto(draftParts({ version: sentUsd() }));
    expect(dto.totals).toEqual({
      subtotal: '1000.00',
      discountAmount: '100.00',
      taxableAmount: '900.00',
      taxAmount: '117.00',
      total: '1017.00',
      effectiveDiscountPct: '10.0000',
    });
    expect(dto.internalCostTotal).toBe('600.00');
    expect(dto.marginPct).toBe('33.3333');
    expect(dto.lines[0]?.quantity).toBe('2.0000');
    expect(dto.lines[0]?.unitPrice).toBe('500.00');
    expect(dto.taxSummary[0]).toMatchObject({ rate: '13.0000', base: '1000.00', tax: '130.00' });
    for (const v of [dto.totals.total, dto.lines[0]?.gross, dto.taxSummary[0]?.tax]) {
      expect(typeof v).toBe('string');
    }
  });

  it('turns bytea hashes into 64-character lower-case hex', () => {
    const dto = toQuotationVersionDto(draftParts({ version: sentUsd() }));
    expect(dto.snapshotSha256).toBe('00ff'.repeat(16));
    expect(dto.renderedSha256).toBe('ab'.repeat(32));
    expect(QuotationVersionDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('builds the NPR snapshot of a foreign-currency version and passes the scan status through', () => {
    const dto = toQuotationVersionDto(
      draftParts({ version: sentUsd(), renderedScanStatus: 'clean' }),
    );
    expect(dto.nprSnapshot).toEqual({
      amountNpr: '135715.65',
      rate: '133.450000',
      rateSource: 'NRB',
      rateDate: '2026-11-02',
    });
    expect(dto.renderedScanStatus).toBe('clean');
    expect(dto.sentAt).toBe('2026-11-02T09:30:00.000Z');
    expect(QuotationVersionDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('has no NPR snapshot for an NPR version even when it carries a rate of 1', () => {
    const v = version({ status: 'approved', fxRate: '1.000000', amountNpr: '1130.00' });
    expect(toQuotationVersionDto(draftParts({ version: v })).nprSnapshot).toBeNull();
  });

  it('maps a percentage discount without trailing zeros and an amount discount to two decimals', () => {
    const pct = toQuotationVersionDto(
      draftParts({ version: version({ discountMode: 'pct', discountInput: '12.5000' }) }),
    );
    expect(pct.discount).toEqual({ mode: 'pct', value: '12.5' });
    const whole = toQuotationVersionDto(
      draftParts({ version: version({ discountMode: 'pct', discountInput: '100.0000' }) }),
    );
    expect(whole.discount).toEqual({ mode: 'pct', value: '100' });
    const amount = toQuotationVersionDto(
      draftParts({ version: version({ discountMode: 'amount', discountInput: '50.0000' }) }),
    );
    expect(amount.discount).toEqual({ mode: 'amount', value: '50.00' });
    for (const d of [pct, whole, amount]) {
      expect(QuotationVersionDtoSchema.safeParse(d).success).toBe(true);
    }
  });

  it('orders lines by line number and keeps the internal cost of a line', () => {
    const dto = toQuotationVersionDto(
      draftParts({ lines: [line(2, { unitCost: '300.00' }), line(1)] }),
    );
    expect(dto.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(dto.lines[1]?.unitCost).toBe('300.00');
    expect(dto.lines[0]?.unitCost).toBeNull();
  });

  it('carries the rejection source of a rejected version', () => {
    const v = version({
      status: 'rejected',
      rejectionSource: 'customer',
      rejectedAt: T1,
      snapshotSha256: HASH_B,
    });
    const dto = toQuotationVersionDto(draftParts({ version: v }));
    expect(dto.rejectionSource).toBe('customer');
    expect(QuotationVersionDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('refuses a quotation that has no customer, and a payment schedule that is not valid', () => {
    expect(() =>
      toQuotationVersionDto(draftParts({ quotation: quotation({ customerPartyId: null }) })),
    ).toThrow(/customer/i);
    expect(() =>
      toQuotationVersionDto(
        draftParts({ version: version({ paymentSchedule: { not: 'array' } }) }),
      ),
    ).toThrow();
  });
});

describe('toQuotationDto', () => {
  it('maps the parent with the status of its current version', () => {
    const dto = toQuotationDto(quotation(), 'approved');
    expect(QuotationDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({
      id: QUOTATION,
      number: 'QT-2026-0042',
      customerId: CUSTOMER,
      currentVersionId: VERSION_2,
      status: 'approved',
      version: 3,
      createdAt: '2026-11-01T08:00:00.000Z',
    });
  });

  it('refuses a parent without a customer or a current version', () => {
    expect(() => toQuotationDto(quotation({ customerPartyId: null }), 'draft')).toThrow(
      /customer/i,
    );
    expect(() => toQuotationDto(quotation({ currentVersionId: null }), 'draft')).toThrow(
      /current version/i,
    );
  });
});

describe('toQuotationListItem', () => {
  it('adds the current version figures and the names a list shows', () => {
    const item = toQuotationListItem(quotation(), sentUsd(), {
      customerName: 'Himal Traders',
      ownerName: null,
      canEdit: false,
    });
    expect(QuotationListItemSchema.safeParse(item).success).toBe(true);
    expect(item).toMatchObject({
      status: 'sent',
      currency: 'USD',
      total: '1017.00',
      validUntil: '2026-11-30',
      customerName: 'Himal Traders',
      ownerName: null,
      canEdit: false,
    });
  });
});

describe('toQuotationDetail', () => {
  const v1 = version({ status: 'superseded', supersededByVersionId: VERSION_2 });
  const v2 = sentUsd();

  const detailParts = () => ({
    quotation: quotation(),
    versions: [
      {
        version: v2,
        lines: [line(1, { versionId: VERSION_2 })],
        taxSummary: [],
        renderedScanStatus: 'clean' as const,
      },
      { version: v1, lines: [line(1)], taxSummary: [tax()], renderedScanStatus: null },
    ],
    statusHistory: [
      history({
        id: id(301),
        toStatus: 'sent',
        fromStatus: 'approved',
        at: T1,
        versionId: VERSION_2,
      }),
      history(),
    ],
    customerName: 'Himal Traders',
    contacts: [
      { id: id(60), fullName: 'Sita Rai', emailNorm: 'sita@example.com' },
      { id: id(61), fullName: 'Ram Thapa', emailNorm: null },
    ],
    capabilities: { canEdit: false, canRevise: true },
  });

  it('parses with the contract schema and derives the parent status from the current version', () => {
    const dto = toQuotationDetail(detailParts());
    expect(QuotationDetailSchema.safeParse(dto).success).toBe(true);
    expect(dto.quotation.status).toBe('sent');
    expect(dto.versions.map((v) => v.revisionNo)).toEqual([1, 2]);
    expect(dto.versions[1]?.renderedScanStatus).toBe('clean');
    expect(dto.statusHistory.map((h) => h.toStatus)).toEqual(['draft', 'sent']);
    expect(dto.statusHistory[0]).toMatchObject({
      fromStatus: null,
      at: '2026-11-01T08:00:00.000Z',
    });
    expect(dto.contacts).toEqual([
      { id: id(60), name: 'Sita Rai', email: 'sita@example.com' },
      { id: id(61), name: 'Ram Thapa', email: null },
    ]);
    expect(dto.capabilities).toEqual({ canEdit: false, canRevise: true });
  });

  it('fails loudly when the current version is not among the versions', () => {
    const parts = detailParts();
    parts.versions = parts.versions.filter((p) => p.version.id !== VERSION_2);
    expect(() => toQuotationDetail(parts)).toThrow(/current version/i);
  });
});
