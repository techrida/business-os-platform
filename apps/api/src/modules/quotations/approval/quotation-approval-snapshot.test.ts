// Unit tests of the quotation approval snapshot and the two version hashes (Q2 part 1). Pure: the golden pricing
// case goes through priceQuotation, then through the snapshot builder and the hashes.
import { QuotationApprovalSnapshotSchema } from '@bos/contracts';
import type { quotationVersions } from '@bos/db';
import { describe, expect, it } from 'vitest';

import { priceQuotation, type FxSnapshot } from '../pricing/pricing';
import type { PricedVersion, PricingInput, PricingLineInput } from '../pricing/pricing.types';
import type { TaxCodeRow } from '../pricing/tax-codes.resolver';
import {
  buildApprovalSnapshot,
  contentSha256,
  materialFieldsOf,
  snapshotSha256,
} from './quotation-approval-snapshot';

type VersionRow = typeof quotationVersions.$inferSelect;

const NPR_FX: FxSnapshot = { rate: '1', source: null, date: null };
const always = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const VAT13: TaxCodeRow = {
  ...always,
  id: 'tc-vat',
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat',
  rateBp: 1300,
};
const EXEMPT: TaxCodeRow = {
  ...always,
  id: 'tc-ex',
  code: 'EXEMPT',
  name: 'Exempt',
  kind: 'exempt',
  rateBp: 0,
};

const line = (
  lineNo: number,
  quantity: string,
  unitPrice: string,
  extra: Partial<PricingLineInput> = {},
): PricingLineInput => ({
  lineNo,
  description: `Line ${lineNo}`,
  uom: 'job',
  quantity,
  unitPrice,
  taxCodeId: VAT13.id,
  ...extra,
});

const input = (lines: PricingLineInput[], extra: Partial<PricingInput> = {}): PricingInput => ({
  currency: 'NPR',
  issueDate: '2026-11-09',
  lines,
  discount: null,
  ...extra,
});

/** The P2 golden case: 8% discount, VAT 13% on two lines and an exempt third line (total 2,690,999.99). */
const golden = (): PricedVersion =>
  priceQuotation(
    input(
      [
        line(1, '1', '1800000.00'),
        line(2, '1', '700000.00'),
        line(3, '3', '33333.33', { taxCodeId: EXEMPT.id }),
      ],
      { discount: { mode: 'pct', value: '8' } },
    ),
    [VAT13, EXEMPT],
    NPR_FX,
  );

const IDENTITY = {
  currency: 'NPR' as const,
  customerName: 'Himal Traders Pvt. Ltd.',
  quotationNumber: 'QT-2026-0001',
  revisionNo: 1,
};

/** A full quotation_versions row for `priced`, as the submit statement would leave it. */
function versionRowOf(priced: PricedVersion, extra: Partial<VersionRow> = {}): VersionRow {
  const c = priced.columns;
  return {
    documentStyle: null,
    renderAttempts: 0,
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    organizationId: '33333333-3333-4333-8333-333333333333',
    quotationId: '44444444-4444-4444-8444-444444444444',
    revisionNo: 1,
    status: 'draft',
    rejectionSource: null,
    contactId: '55555555-5555-4555-8555-555555555555',
    templateId: null,
    currency: 'NPR',
    issueDate: '2026-11-09',
    validUntil: '2026-12-09',
    scope: 'Supply and install',
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: '6 weeks',
    paymentTermId: null,
    paymentSchedule: [{ label: 'Advance', percent: '50' }],
    discountMode: 'pct',
    discountInput: '8.0000',
    subtotal: c.subtotal,
    discountAmount: c.discountAmount,
    taxableAmount: c.taxableAmount,
    taxAmount: c.taxAmount,
    total: c.total,
    effectiveDiscountPct: c.effectiveDiscountPct,
    fxRate: c.fxRate,
    fxSource: c.fxSource,
    fxDate: c.fxDate,
    amountNpr: c.amountNpr,
    nprTaxableAmount: c.nprTaxableAmount,
    internalCostTotal: c.internalCostTotal,
    marginPct: c.marginPct,
    calcVersion: c.calcVersion,
    contentSha256: null,
    snapshotSha256: null,
    approvalRequestId: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderState: 'none',
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
    createdAt: new Date('2026-11-09T00:00:00Z'),
    updatedAt: new Date('2026-11-09T00:00:00Z'),
    ...extra,
  };
}

describe('buildApprovalSnapshot', () => {
  it('turns the golden pricing case into a snapshot that parses', () => {
    const snapshot = buildApprovalSnapshot({ priced: golden(), ...IDENTITY });
    expect(QuotationApprovalSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toEqual({
      nprTotal: '2690999.99',
      effectiveDiscountPct: '8.0000',
      marginPct: null,
      nprDiscountAmount: '208000.00',
      currency: 'NPR',
      fxRate: '1.000000',
      customerName: 'Himal Traders Pvt. Ltd.',
      quotationNumber: 'QT-2026-0001',
      revisionNo: 1,
      discountApprovalRequired: false,
    });
  });

  it('reads effectiveDiscountPct from the 4 dp column, not from the unrounded fact', () => {
    // A third of the subtotal: the fact is full precision, the column is rounded to 4 dp.
    const priced = priceQuotation(
      input([line(1, '1', '300.00')], { discount: { mode: 'amount', value: '100.00' } }),
      [VAT13, EXEMPT],
      NPR_FX,
    );
    expect(priced.facts.effectiveDiscountPct).not.toMatch(/^\d{1,3}\.\d{1,4}$/);
    const snapshot = buildApprovalSnapshot({ priced, ...IDENTITY });
    expect(snapshot.effectiveDiscountPct).toBe('33.3333');
    expect(snapshot.discountApprovalRequired).toBe(true);
  });

  it('keeps 4 dp even when the facts carry a different, unrounded value', () => {
    const priced = golden();
    const withNoisyFacts: PricedVersion = {
      ...priced,
      facts: { ...priced.facts, effectiveDiscountPct: '8.00000000000000001234' },
    };
    const snapshot = buildApprovalSnapshot({ priced: withNoisyFacts, ...IDENTITY });
    expect(snapshot.effectiveDiscountPct).toBe('8.0000');
  });

  it('gives a null margin when the margin is out of range', () => {
    const priced = priceQuotation(
      input([line(1, '1', '100.00', { unitCost: '2000000.00' })]),
      [VAT13, EXEMPT],
      NPR_FX,
    );
    expect(priced.facts.marginOutOfRange).toBe(true);
    expect(buildApprovalSnapshot({ priced, ...IDENTITY }).marginPct).toBeNull();
  });

  it('gives a null margin whenever marginOutOfRange is set, even if a column value is present', () => {
    const priced = golden();
    const forced: PricedVersion = {
      ...priced,
      columns: { ...priced.columns, marginPct: '-1000.5000' },
      facts: { ...priced.facts, marginOutOfRange: true },
    };
    expect(buildApprovalSnapshot({ priced: forced, ...IDENTITY }).marginPct).toBeNull();
  });

  it('carries a known margin from the columns', () => {
    const priced = priceQuotation(
      input([line(1, '2', '500.00', { unitCost: '300.00' })]),
      [VAT13, EXEMPT],
      NPR_FX,
    );
    const snapshot = buildApprovalSnapshot({ priced, ...IDENTITY });
    expect(snapshot.marginPct).toBe(priced.columns.marginPct);
    expect(snapshot.marginPct).toBe('40.0000');
  });

  it('refuses an identity the schema rejects', () => {
    expect(() =>
      buildApprovalSnapshot({ priced: golden(), ...IDENTITY, customerName: '' }),
    ).toThrow();
  });
});

describe('materialFieldsOf and the content hash', () => {
  const priced = golden();
  const material = (row: VersionRow = versionRowOf(priced), p: PricedVersion = priced) =>
    materialFieldsOf(row, p.lines, p.taxSummary);

  it('hashes the same input to the same 32 bytes', () => {
    const a = contentSha256(material());
    const b = contentSha256(material(versionRowOf(golden()), golden()));
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
  });

  it('does not depend on the order of lines or tax summary rows', () => {
    const shuffled = materialFieldsOf(
      versionRowOf(priced),
      [...priced.lines].reverse(),
      [...priced.taxSummary].reverse(),
    );
    expect(contentSha256(shuffled).equals(contentSha256(material()))).toBe(true);
  });

  it('changes when one version field changes', () => {
    const base = contentSha256(material());
    const changes: Partial<VersionRow>[] = [
      { scope: 'Supply only' },
      { total: '2690999.98' },
      { fxRate: '2.000000' },
      { validUntil: '2026-12-10' },
      { revisionReason: 'Customer asked for a lower price' },
      { paymentSchedule: [{ label: 'Advance', percent: '40' }] },
    ];
    for (const change of changes) {
      const changed = contentSha256(material(versionRowOf(priced, change)));
      expect(changed.equals(base), JSON.stringify(change)).toBe(false);
    }
  });

  it('changes when a line or a tax summary row changes', () => {
    const base = contentSha256(material());
    const lines = priced.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1800000.01' } : l));
    const taxSummary = priced.taxSummary.map((t, i) => (i === 0 ? { ...t, tax: '1.00' } : t));
    expect(
      contentSha256(materialFieldsOf(versionRowOf(priced), lines, priced.taxSummary)).equals(base),
    ).toBe(false);
    expect(
      contentSha256(materialFieldsOf(versionRowOf(priced), priced.lines, taxSummary)).equals(base),
    ).toBe(false);
  });

  it('hashes a version without terms and conditions to the bytes it had before the column existed', () => {
    // Pinned from the code before migration 0047 (no termsAndConditions key at all). Existing approved versions
    // are re-checked against their stored hash, so this value must never move.
    const PRE_0047 = '880195ac5b89d8d4612fc3ea3c3c12baf244405bba1b483627b34ea9148e6ce8';
    expect(contentSha256(material()).toString('hex')).toBe(PRE_0047);
    expect(
      contentSha256(material(versionRowOf(priced, { termsAndConditions: null }))).toString('hex'),
    ).toBe(PRE_0047);
    expect(material().version).not.toHaveProperty('termsAndConditions');
  });

  it('changes when terms and conditions are set or edited, and an empty string is not the same as none', () => {
    const base = contentSha256(material());
    const hashOf = (termsAndConditions: string) =>
      contentSha256(material(versionRowOf(priced, { termsAndConditions }))).toString('hex');
    const a = hashOf('Payment within 30 days.');
    expect(a).not.toBe(base.toString('hex'));
    expect(hashOf('Payment within 15 days.')).not.toBe(a);
    expect(hashOf('')).not.toBe(base.toString('hex'));
    expect(
      materialFieldsOf(versionRowOf(priced, { termsAndConditions: 'x' }), [], []).version,
    ).toHaveProperty('termsAndConditions', 'x');
  });

  it('does not change when a non-material field changes', () => {
    const base = contentSha256(material());
    const changed = versionRowOf(priced, {
      status: 'submitted',
      renderState: 'rendered',
      renderedSha256: Buffer.from('ab'.repeat(32), 'hex'),
      approvalRequestId: '66666666-6666-4666-8666-666666666666',
      submittedAt: new Date('2026-11-10T00:00:00Z'),
      version: 7,
      updatedAt: new Date('2026-11-11T00:00:00Z'),
    });
    expect(contentSha256(material(changed)).equals(base)).toBe(true);
  });

  it('never includes the hash columns, so the hash is not circular', () => {
    const withHashes = versionRowOf(priced, {
      contentSha256: Buffer.alloc(32, 1),
      snapshotSha256: Buffer.alloc(32, 2),
    });
    const fields = material(withHashes);
    expect(JSON.stringify(fields)).not.toMatch(/sha256/i);
    expect(contentSha256(fields).equals(contentSha256(material()))).toBe(true);
  });

  it('holds every material column except the two hashes, and no row keys or timestamps', () => {
    const fields = materialFieldsOf(
      versionRowOf(priced),
      priced.lines.map((l) => ({ ...l, id: 'x', versionId: 'y', createdAt: new Date() })),
      priced.taxSummary,
    );
    expect(Object.keys(fields.version)).toHaveLength(28);
    expect(fields.version).toMatchObject({ scope: 'Supply and install', calcVersion: 1 });
    expect(Object.keys(fields.lines[0]!).sort()).toEqual(Object.keys(priced.lines[0]!).sort());
    expect(Object.keys(fields.taxSummary[0]!).sort()).toEqual(
      Object.keys(priced.taxSummary[0]!).sort(),
    );
  });
});

describe('snapshotSha256', () => {
  const snapshot = buildApprovalSnapshot({ priced: golden(), ...IDENTITY });

  it('returns 32 bytes and is stable', () => {
    const a = snapshotSha256(snapshot);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(a.equals(snapshotSha256({ ...snapshot }))).toBe(true);
  });

  it('changes when one snapshot field changes', () => {
    expect(
      snapshotSha256(snapshot).equals(snapshotSha256({ ...snapshot, nprTotal: '2690999.98' })),
    ).toBe(false);
    expect(
      snapshotSha256(snapshot).equals(
        snapshotSha256({ ...snapshot, discountApprovalRequired: true }),
      ),
    ).toBe(false);
  });
});
