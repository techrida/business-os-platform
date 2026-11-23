import { describe, expect, it } from 'vitest';

import {
  CreateQuotationBodySchema,
  AcceptanceDtoSchema,
  CancelQuotationBodySchema,
  DiscountSchema,
  EVIDENCE_KINDS,
  NonNegativeDecimalString,
  PaymentMilestoneDtoSchema,
  PaymentMilestoneSchema,
  PaymentTermSchema,
  PreviewResultSchema,
  QUOTATION_ACTIONS,
  QUOTATION_REVISION_RULES,
  QUOTATION_STATUSES,
  QUOTATION_TRANSITIONS,
  QuantityString,
  QuotationApprovalSnapshotSchema,
  QuotationDetailSchema,
  QuotationLineInputSchema,
  ListQuotationsQuerySchema,
  QuotationSummaryQuerySchema,
  QuotationSummarySchema,
  QuotationListItemSchema,
  QuotationTaxSummaryItemSchema,
  QuotationVersionContentSchema,
  QuotationVersionDtoSchema,
  RecordOutcomeBodySchema,
  ReviseQuotationBodySchema,
  TaxCodeSchema,
  UpdateQuotationDraftBodySchema,
  UpdateQuotationVersionBodySchema,
  canCancelQuotation,
  canReviseQuotation,
  isQuotationEditable,
  quotationTransitionsFrom,
} from './index.js';

const id = () => crypto.randomUUID();

describe('QuantityString (numeric(18,4), above zero)', () => {
  it('accepts up to 4 decimals', () => {
    for (const q of ['1', '1.5', '0.0001', '2.2500', '99999999999999.9999']) {
      expect(QuantityString.safeParse(q).success, q).toBe(true);
    }
  });

  it('rejects a JS number, a fifth decimal, zero, a negative and junk', () => {
    expect(QuantityString.safeParse(1.5).success).toBe(false);
    for (const q of ['1.23456', '0', '0.0000', '-1', '1e3', '', ' 1', '1.']) {
      expect(QuantityString.safeParse(q).success, q).toBe(false);
    }
  });
});

describe('NonNegativeDecimalString (numeric(18,2), zero or more)', () => {
  it('accepts zero and 2-decimal amounts', () => {
    for (const p of ['0', '0.00', '10', '1234567.89']) {
      expect(NonNegativeDecimalString.safeParse(p).success, p).toBe(true);
    }
  });

  it('rejects a negative, a third decimal and a JS number', () => {
    expect(NonNegativeDecimalString.safeParse('-1').success).toBe(false);
    expect(NonNegativeDecimalString.safeParse('-0.01').success).toBe(false);
    expect(NonNegativeDecimalString.safeParse('10.005').success).toBe(false);
    expect(NonNegativeDecimalString.safeParse(10).success).toBe(false);
  });
});

describe('QuotationLineInputSchema', () => {
  const line = {
    description: 'Solar panel 550W',
    uom: 'pcs',
    quantity: '12',
    unitPrice: '45000.00',
    taxCodeId: id(),
  };

  it('parses a line and takes an optional internal unit cost', () => {
    expect(QuotationLineInputSchema.safeParse(line).success).toBe(true);
    expect(QuotationLineInputSchema.safeParse({ ...line, unitCost: '30000.00' }).success).toBe(
      true,
    );
  });

  it('rejects numbers for quantity and price, zero quantity, and a negative price', () => {
    expect(QuotationLineInputSchema.safeParse({ ...line, quantity: 12 }).success).toBe(false);
    expect(QuotationLineInputSchema.safeParse({ ...line, unitPrice: 45000 }).success).toBe(false);
    expect(QuotationLineInputSchema.safeParse({ ...line, quantity: '0' }).success).toBe(false);
    expect(QuotationLineInputSchema.safeParse({ ...line, unitPrice: '-1.00' }).success).toBe(false);
  });

  it('has no per-line discount: the discount is on the quotation (C5)', () => {
    expect(QuotationLineInputSchema.safeParse({ ...line, discount: '5' }).success).toBe(false);
  });
});

describe('DiscountSchema', () => {
  it('takes a percentage from 0 to 100 and a non-negative amount', () => {
    for (const value of ['0', '12', '12.0001', '100', '100.0000']) {
      expect(DiscountSchema.safeParse({ mode: 'pct', value }).success, value).toBe(true);
    }
    expect(DiscountSchema.safeParse({ mode: 'amount', value: '2500.50' }).success).toBe(true);
  });

  it('rejects a percentage over 100, a negative, and a number', () => {
    for (const value of ['100.0001', '101', '-1', '12.00001']) {
      expect(DiscountSchema.safeParse({ mode: 'pct', value }).success, value).toBe(false);
    }
    expect(DiscountSchema.safeParse({ mode: 'amount', value: '-5.00' }).success).toBe(false);
    expect(DiscountSchema.safeParse({ mode: 'pct', value: 12 }).success).toBe(false);
  });
});

describe('quotation statuses and the transition table', () => {
  it('has ten statuses, including Superseded', () => {
    expect([...QUOTATION_STATUSES]).toEqual([
      'draft',
      'submitted',
      'returned',
      'approved',
      'sent',
      'accepted',
      'rejected',
      'expired',
      'cancelled',
      'superseded',
    ]);
  });

  it('allows exactly the edges of the state machine', () => {
    const edges = QUOTATION_TRANSITIONS.map((t) => `${t.from}>${t.to}`);
    expect([...new Set(edges)].sort()).toEqual(
      [
        'draft>submitted',
        'draft>cancelled',
        'submitted>returned',
        'submitted>rejected',
        'submitted>approved',
        'submitted>cancelled',
        'returned>submitted',
        'returned>cancelled',
        'approved>sent',
        'approved>cancelled',
        'approved>expired',
        'approved>superseded',
        'sent>accepted',
        'sent>rejected',
        'sent>cancelled',
        'sent>expired',
        'sent>superseded',
        'superseded>approved',
        'superseded>sent',
      ].sort(),
    );
  });

  it('has no way out of accepted, rejected, expired or cancelled', () => {
    for (const s of ['accepted', 'rejected', 'expired', 'cancelled'] as const) {
      expect(quotationTransitionsFrom(s), s).toEqual([]);
    }
  });

  it('leaves superseded only by a restore, back to the approved or sent status it had (R6D)', () => {
    const out = quotationTransitionsFrom('superseded');
    expect(out.map((t) => `${t.action}>${t.to}`).sort()).toEqual([
      'restore>approved',
      'restore>sent',
    ]);
    expect(out.every((t) => t.by === 'user' && t.reasonRequired)).toBe(true);
  });

  it('supersedes only on a revision of an approved or sent version', () => {
    const into = QUOTATION_TRANSITIONS.filter((t) => t.to === 'superseded');
    expect(into.map((t) => t.from).sort()).toEqual(['approved', 'sent']);
    for (const t of into) expect(t.action).toBe('revise');
  });

  it('needs a reason to return, reject, or cancel, and none to approve or submit', () => {
    const needs = (action: string) =>
      QUOTATION_TRANSITIONS.filter((t) => t.action === action).map((t) => t.reasonRequired);
    for (const a of [
      'return',
      'reject',
      'customer_reject',
      'cancel',
      'cancel_on_lost',
      'revise',
      'restore',
    ]) {
      expect(needs(a).length, a).toBeGreaterThan(0);
      expect(needs(a).every(Boolean), a).toBe(true);
    }
    for (const a of ['submit', 'approve', 'send', 'accept']) {
      expect(needs(a).some(Boolean), a).toBe(false);
    }
  });

  it('has no withdraw (Recall): only an approver returns a Submitted version, and Cancel ends it (F1-Q27)', async () => {
    expect(QUOTATION_TRANSITIONS.map((t) => t.action)).not.toContain('withdraw');
    const back = QUOTATION_TRANSITIONS.filter((t) => t.from === 'submitted' && t.to === 'returned');
    expect(back.map((t) => t.action)).toEqual(['return']);
    // No dead body schema is left for a route that does not exist.
    const contracts: Record<string, unknown> = await import('./index.js');
    expect(Object.keys(contracts).filter((k) => /withdrawquotation/i.test(k))).toEqual([]);
  });

  it('lets a Lost opportunity end exactly the live statuses, as the system', () => {
    const edges = QUOTATION_TRANSITIONS.filter((x) => x.action === 'cancel_on_lost');
    expect(edges.map((t) => t.from).sort()).toEqual(
      [...QUOTATION_REVISION_RULES.liveStatuses].sort(),
    );
    for (const t of edges) {
      expect(t.by).toBe('system');
      expect(t.to).toBe('cancelled');
    }
    // A user's Cancel button is unchanged: it never reaches an Approved or Sent version.
    expect(canCancelQuotation('sent')).toBe(false);
    expect(canCancelQuotation('approved')).toBe(false);
  });

  it('has no cascade_reject: a Lost opportunity cancels an Approved or Sent version (R5 EF2)', () => {
    // Fails on the old code: the unused cascade_reject action and its two edges to Rejected were still there.
    expect([...QUOTATION_ACTIONS] as string[]).not.toContain('cascade_reject');
    expect(QUOTATION_TRANSITIONS.map((t) => t.action as string)).not.toContain('cascade_reject');
    const lost = QUOTATION_TRANSITIONS.filter((t) => t.action === 'cancel_on_lost');
    for (const from of ['approved', 'sent'] as const) {
      expect(lost.find((t) => t.from === from)?.to, from).toBe('cancelled');
    }
  });

  it('lets only the system expire a version', () => {
    for (const t of QUOTATION_TRANSITIONS.filter((x) => x.action === 'expire')) {
      expect(t.by).toBe('system');
    }
  });
});

describe('revision rules as data', () => {
  it('edits only in draft and returned', () => {
    expect([...QUOTATION_REVISION_RULES.editableStatuses].sort()).toEqual(['draft', 'returned']);
    expect(isQuotationEditable('draft')).toBe(true);
    expect(isQuotationEditable('submitted')).toBe(false);
    expect(isQuotationEditable('approved')).toBe(false);
  });

  it('revises from approved, sent, rejected and expired, never from accepted', () => {
    expect([...QUOTATION_REVISION_RULES.reviseFrom].sort()).toEqual([
      'approved',
      'expired',
      'rejected',
      'sent',
    ]);
    expect(canReviseQuotation('sent')).toBe(true);
    expect(canReviseQuotation('rejected')).toBe(true);
    expect(canReviseQuotation('accepted')).toBe(false);
    expect(canReviseQuotation('draft')).toBe(false);
  });

  it('supersedes only approved and sent, and keeps one live version per quotation', () => {
    expect([...QUOTATION_REVISION_RULES.supersededOnRevise].sort()).toEqual(['approved', 'sent']);
    expect([...QUOTATION_REVISION_RULES.liveStatuses].sort()).toEqual([
      'approved',
      'draft',
      'returned',
      'sent',
      'submitted',
    ]);
    expect(QUOTATION_REVISION_RULES.reasonRequired).toBe(true);
    expect(QUOTATION_REVISION_RULES.newVersionStatus).toBe('draft');
  });

  it('agrees with the transition table: a status is superseded on revise exactly when an edge says so', () => {
    for (const s of QUOTATION_STATUSES) {
      const edge = quotationTransitionsFrom(s).some((t) => t.action === 'revise');
      expect(QUOTATION_REVISION_RULES.supersededOnRevise.includes(s as never), s).toBe(edge);
    }
  });

  it('cancels only a version not yet approved: draft, returned or submitted (F1-Q27)', () => {
    expect(QUOTATION_STATUSES.filter(canCancelQuotation).sort()).toEqual([
      'draft',
      'returned',
      'submitted',
    ]);
  });

  it('requires a reason to revise or cancel', () => {
    expect(ReviseQuotationBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(ReviseQuotationBodySchema.safeParse({ reason: '  ', expectedVersion: 1 }).success).toBe(
      false,
    );
    expect(
      ReviseQuotationBodySchema.safeParse({ reason: 'Customer changed scope', expectedVersion: 1 })
        .success,
    ).toBe(true);
    expect(CancelQuotationBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });
});

describe('QuotationVersionContentSchema', () => {
  const line = {
    description: 'Panel',
    uom: 'pcs',
    quantity: '2',
    unitPrice: '100.00',
    taxCodeId: id(),
  };
  const content = {
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    lines: [line],
    discount: { mode: 'pct', value: '5' },
    paymentSchedule: [
      { label: 'Advance', percent: '60' },
      { label: 'Delivery', percent: '20' },
      { label: 'Handover', percent: '20' },
    ],
  };

  it('parses a full draft', () => {
    expect(QuotationVersionContentSchema.safeParse(content).success).toBe(true);
  });

  it('allows validity to end the day it starts, but not before', () => {
    expect(
      QuotationVersionContentSchema.safeParse({ ...content, validUntil: '2026-11-08' }).success,
    ).toBe(true);
    expect(
      QuotationVersionContentSchema.safeParse({ ...content, validUntil: '2026-11-07' }).success,
    ).toBe(false);
  });

  it('needs at least one line', () => {
    expect(QuotationVersionContentSchema.safeParse({ ...content, lines: [] }).success).toBe(false);
  });

  it('needs a payment schedule that adds up to 100 percent', () => {
    const short = [
      { label: 'Advance', percent: '60' },
      { label: 'Delivery', percent: '20' },
    ];
    expect(
      QuotationVersionContentSchema.safeParse({ ...content, paymentSchedule: short }).success,
    ).toBe(false);
    expect(
      QuotationVersionContentSchema.safeParse({
        ...content,
        paymentSchedule: [
          { label: 'A', percent: '33.33' },
          { label: 'B', percent: '33.33' },
          { label: 'C', percent: '33.34' },
        ],
      }).success,
    ).toBe(true);
  });

  it('validates four-decimal payment shares and rejects a fifth digit or a short total', () => {
    const parse = (percents: string[]) =>
      QuotationVersionContentSchema.safeParse({
        ...content,
        paymentSchedule: percents.map((percent, i) => ({ label: `Step ${i + 1}`, percent })),
      });
    expect(parse(['33.3333', '33.3333', '33.3334']).success).toBe(true);
    expect(parse(['33.33330', '33.3333', '33.3334']).success).toBe(false);
    expect(parse(['33.3333', '33.3333', '33.3333']).success).toBe(false);
  });

  it('only INR, NPR and USD', () => {
    expect(QuotationVersionContentSchema.safeParse({ ...content, currency: 'EUR' }).success).toBe(
      false,
    );
  });
});

describe('QuotationTaxSummaryItemSchema', () => {
  it('keeps base and tax as strings', () => {
    const item = {
      taxCodeId: id(),
      label: 'VAT 13%',
      rate: '13.0000',
      base: '2300000.00',
      tax: '299000.00',
    };
    expect(QuotationTaxSummaryItemSchema.safeParse(item).success).toBe(true);
    expect(QuotationTaxSummaryItemSchema.safeParse({ ...item, base: 2300000 }).success).toBe(false);
    expect(QuotationTaxSummaryItemSchema.safeParse({ ...item, tax: '299000.001' }).success).toBe(
      false,
    );
  });
});

describe('acceptance evidence', () => {
  it('names the three kinds; "both" is a policy, not a kind', () => {
    expect([...EVIDENCE_KINDS]).toEqual(['contract', 'purchase_order', 'signed_quote']);
  });

  const accepted = {
    outcome: 'accepted',
    decidedOn: '2026-11-20',
    evidenceKinds: ['signed_quote'],
    expectedVersion: 4,
  };

  it('parses an acceptance with evidence, and a combination of kinds', () => {
    expect(RecordOutcomeBodySchema.safeParse(accepted).success).toBe(true);
    expect(
      RecordOutcomeBodySchema.safeParse({
        ...accepted,
        evidenceKinds: ['signed_quote', 'purchase_order'],
      }).success,
    ).toBe(true);
  });

  it('rejects an acceptance with no evidence kind, an unknown kind, or a repeated kind', () => {
    expect(RecordOutcomeBodySchema.safeParse({ ...accepted, evidenceKinds: [] }).success).toBe(
      false,
    );
    expect(
      RecordOutcomeBodySchema.safeParse({ ...accepted, evidenceKinds: ['verbal'] }).success,
    ).toBe(false);
    expect(
      RecordOutcomeBodySchema.safeParse({ ...accepted, evidenceKinds: ['contract', 'contract'] })
        .success,
    ).toBe(false);
  });

  it('lets a rejection carry no evidence, but needs a comment', () => {
    const rejected = {
      outcome: 'rejected',
      decidedOn: '2026-11-20',
      evidenceKinds: [],
      expectedVersion: 4,
    };
    expect(
      RecordOutcomeBodySchema.safeParse({ ...rejected, comment: 'Chose a rival' }).success,
    ).toBe(true);
    expect(RecordOutcomeBodySchema.safeParse(rejected).success).toBe(false);
  });
});

describe('QuotationVersionDtoSchema', () => {
  const iso = '2026-11-08T10:00:00+05:45';
  const version = () => ({
    id: id(),
    quotationId: id(),
    number: 'QT-2082-0042',
    revisionNo: 2,
    status: 'superseded',
    rejectionSource: null,
    customerId: id(),
    contactId: null,
    templateId: null,
    currency: 'USD',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    scope: null,
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: null,
    paymentTermId: null,
    paymentSchedule: [],
    discount: { mode: 'pct', value: '13' },
    lines: [],
    taxSummary: [],
    totals: {
      subtotal: '2599999.99',
      discountAmount: '208000.00',
      taxableAmount: '2391999.99',
      taxAmount: '299000.00',
      total: '2690999.99',
      effectiveDiscountPct: '8.0000',
    },
    internalCostTotal: null,
    marginPct: null,
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderedScanStatus: null,
    renderFailed: false,
    supersedesVersionId: null,
    supersededByVersionId: id(),
    revisionReason: 'Customer changed scope',
    cancelReason: null,
    submittedAt: iso,
    approvedAt: iso,
    sentAt: iso,
    acceptedAt: null,
    rejectedAt: null,
    expiredAt: null,
    cancelledAt: null,
    version: 7,
    createdAt: iso,
    updatedAt: iso,
  });

  it('parses a superseded version with its rejection source and money as strings', () => {
    expect(QuotationVersionDtoSchema.safeParse(version()).success).toBe(true);
    expect(
      QuotationVersionDtoSchema.safeParse({
        ...version(),
        status: 'rejected',
        rejectionSource: 'customer',
      }).success,
    ).toBe(true);
  });

  it('parses a version whose viewer lacks quotation.cost.read: the cost fields are absent (D29a)', () => {
    const line = {
      lineNo: 1,
      catalogItemId: null,
      description: 'Rack server',
      uom: 'pcs',
      quantity: '2.0000',
      unitPrice: '1000.00',
      taxCodeId: id(),
      gross: '2000.00',
      discountAlloc: '0.00',
      taxable: '2000.00',
    };
    const redacted: Record<string, unknown> = { ...version() };
    delete redacted.internalCostTotal;
    delete redacted.marginPct;
    expect(QuotationVersionDtoSchema.safeParse({ ...redacted, lines: [line] }).success).toBe(true);
    // Null still means "no cost recorded", and a recorded cost still parses.
    expect(
      QuotationVersionDtoSchema.safeParse({
        ...redacted,
        lines: [{ ...line, unitCost: null }],
        internalCostTotal: null,
        marginPct: null,
      }).success,
    ).toBe(true);
    expect(
      QuotationVersionDtoSchema.safeParse({
        ...redacted,
        lines: [{ ...line, unitCost: '800.00' }],
        internalCostTotal: '1600.00',
        marginPct: '20.0000',
      }).success,
    ).toBe(true);
    // A malformed cost is still refused rather than ignored.
    expect(
      QuotationVersionDtoSchema.safeParse({ ...redacted, internalCostTotal: 1600 }).success,
    ).toBe(false);
  });

  it('rejects a JS number for a total, and an unknown rejection source', () => {
    const v = version();
    expect(
      QuotationVersionDtoSchema.safeParse({ ...v, totals: { ...v.totals, total: 2690999.99 } })
        .success,
    ).toBe(false);
    expect(
      QuotationVersionDtoSchema.safeParse({ ...v, status: 'rejected', rejectionSource: 'nobody' })
        .success,
    ).toBe(false);
  });

  it('needs a rejection source when rejected, and none otherwise', () => {
    expect(QuotationVersionDtoSchema.safeParse({ ...version(), status: 'rejected' }).success).toBe(
      false,
    );
    expect(
      QuotationVersionDtoSchema.safeParse({ ...version(), rejectionSource: 'internal' }).success,
    ).toBe(false);
  });

  it('carries an amount on every payment schedule row of a version (D36)', () => {
    const row = { label: 'Advance', percent: '100', amount: '2690999.99' };
    const v = QuotationVersionDtoSchema.safeParse({ ...version(), paymentSchedule: [row] });
    expect(v.success).toBe(true);
    expect(
      QuotationVersionDtoSchema.safeParse({
        ...version(),
        paymentSchedule: [{ label: 'Advance', percent: '100' }],
      }).success,
    ).toBe(false);
  });
});

describe('QuotationVersionDtoSchema.renderedScanStatus', () => {
  const iso = '2026-11-08T10:00:00+05:45';
  const base = () => ({
    id: id(),
    quotationId: id(),
    number: 'QT-2082-0042',
    revisionNo: 1,
    status: 'approved',
    rejectionSource: null,
    customerId: id(),
    contactId: null,
    templateId: null,
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    scope: null,
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: null,
    paymentTermId: null,
    paymentSchedule: [],
    discount: null,
    lines: [],
    taxSummary: [],
    totals: {
      subtotal: '100.00',
      discountAmount: '0.00',
      taxableAmount: '100.00',
      taxAmount: '13.00',
      total: '113.00',
      effectiveDiscountPct: '0.0000',
    },
    internalCostTotal: null,
    marginPct: null,
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: id(),
    renderedSha256: null,
    renderedScanStatus: 'clean',
    renderFailed: false,
    supersedesVersionId: null,
    supersededByVersionId: null,
    revisionReason: null,
    cancelReason: null,
    submittedAt: iso,
    approvedAt: iso,
    sentAt: null,
    acceptedAt: null,
    rejectedAt: null,
    expiredAt: null,
    cancelledAt: null,
    version: 1,
    createdAt: iso,
    updatedAt: iso,
  });

  it('takes a document scan status or null, and refuses anything else', () => {
    expect(QuotationVersionDtoSchema.safeParse(base()).success).toBe(true);
    expect(
      QuotationVersionDtoSchema.safeParse({ ...base(), renderedScanStatus: null }).success,
    ).toBe(true);
    for (const status of ['quarantined', 'infected', 'scan_failed']) {
      expect(
        QuotationVersionDtoSchema.safeParse({ ...base(), renderedScanStatus: status }).success,
        status,
      ).toBe(true);
    }
    expect(
      QuotationVersionDtoSchema.safeParse({ ...base(), renderedScanStatus: 'ok' }).success,
    ).toBe(false);
  });

  it('is required: a producer that omits it fails, so the default is deny', () => {
    const { renderedScanStatus: _omitted, ...without } = base();
    expect(QuotationVersionDtoSchema.safeParse(without).success).toBe(false);
  });

  it('carries renderFailed (R4c2), a required boolean: a producer that omits it fails the parse', () => {
    expect(QuotationVersionDtoSchema.safeParse({ ...base(), renderFailed: true }).success).toBe(
      true,
    );
    expect(QuotationVersionDtoSchema.safeParse({ ...base(), renderFailed: 'yes' }).success).toBe(
      false,
    );
    const { renderFailed: _omitted, ...without } = base();
    expect(QuotationVersionDtoSchema.safeParse(without).success).toBe(false);
  });
});

describe('QuotationListItemSchema', () => {
  const iso = '2026-11-08T10:00:00+05:45';
  const item = () => ({
    id: id(),
    number: 'QT-2082-0042',
    customerId: id(),
    opportunityId: id(),
    currentVersionId: id(),
    ownerUserId: id(),
    status: 'sent',
    version: 3,
    createdAt: iso,
    updatedAt: iso,
    customerName: 'Big Kahuna Burger Ltd.',
    currency: 'NPR',
    total: '2690999.99',
    validUntil: '2026-11-23',
    ownerName: 'Amanda Rai',
    canEdit: false,
  });

  it('is the parent DTO plus customer, currency, total, valid-until and owner', () => {
    expect(QuotationListItemSchema.safeParse(item()).success).toBe(true);
    expect(QuotationListItemSchema.safeParse([item()]).success).toBe(false);
  });

  it('allows an unowned quotation, but keeps money a string', () => {
    expect(
      QuotationListItemSchema.safeParse({ ...item(), ownerUserId: null, ownerName: null }).success,
    ).toBe(true);
    expect(QuotationListItemSchema.safeParse({ ...item(), total: 2690999.99 }).success).toBe(false);
    expect(QuotationListItemSchema.safeParse({ ...item(), total: '-5.00' }).success).toBe(false);
  });

  it('refuses a missing customer name, an unknown status and a bad currency', () => {
    const { customerName: _omitted, ...without } = item();
    expect(QuotationListItemSchema.safeParse(without).success).toBe(false);
    expect(QuotationListItemSchema.safeParse({ ...item(), status: 'lost' }).success).toBe(false);
    expect(QuotationListItemSchema.safeParse({ ...item(), currency: 'EUR' }).success).toBe(false);
  });

  it('carries whether the caller may edit the row, as a boolean the server decides', () => {
    const { canEdit: _omitted, ...without } = item();
    expect(QuotationListItemSchema.safeParse(without).success).toBe(false);
    expect(QuotationListItemSchema.safeParse({ ...item(), canEdit: 'yes' }).success).toBe(false);
  });
});

describe('ListQuotationsQuerySchema', () => {
  it('has no default limit (every match), and takes filters, a search and a page', () => {
    const none = ListQuotationsQuerySchema.parse({});
    expect(none).toEqual({ offset: 0 });
    expect(none.limit).toBeUndefined();
    const opportunityId = id();
    const customerId = id();
    expect(
      ListQuotationsQuerySchema.parse({
        status: 'draft',
        customerId,
        opportunityId,
        q: ' acme ',
        limit: '10',
        offset: '30',
      }),
    ).toEqual({
      status: ['draft'],
      customerId: [customerId],
      opportunityId,
      q: 'acme',
      limit: 10,
      offset: 30,
    });
  });

  it('takes a repeated status and customer, drops duplicates and blank values', () => {
    const [a, b] = [id(), id()];
    expect(
      ListQuotationsQuerySchema.parse({
        status: ['draft', 'sent', 'draft', ''],
        customerId: [a, b],
      }),
    ).toMatchObject({ status: ['draft', 'sent'], customerId: [a, b] });
    expect(ListQuotationsQuerySchema.parse({ status: '' }).status).toEqual([]);
  });

  it('ignores a search that is too short and refuses a bad value or an unknown key', () => {
    expect(ListQuotationsQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
    expect(ListQuotationsQuerySchema.safeParse({ opportunityId: 'x' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ status: 'lost' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ status: ['draft', 'lost'] }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ customerId: 'x' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ opportunityId: [id(), id()] }).success).toBe(
      false,
    );
    expect(ListQuotationsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(ListQuotationsQuerySchema.safeParse({ sort: 'total' }).success).toBe(false);
  });
});

describe('QuotationSummaryQuerySchema and QuotationSummarySchema', () => {
  it('takes the list filters except status and paging', () => {
    const customerId = id();
    expect(QuotationSummaryQuerySchema.parse({})).toEqual({});
    expect(QuotationSummaryQuerySchema.parse({ customerId, q: 'acme' })).toEqual({
      customerId: [customerId],
      q: 'acme',
    });
    expect(QuotationSummaryQuerySchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(QuotationSummaryQuerySchema.safeParse({ limit: '5' }).success).toBe(false);
  });

  it('needs a count for every status', () => {
    const byStatus = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, 0]));
    expect(QuotationSummarySchema.safeParse({ total: 0, byStatus }).success).toBe(true);
    expect(QuotationSummarySchema.safeParse({ total: 0, byStatus: { draft: 0 } }).success).toBe(
      false,
    );
    expect(
      QuotationSummarySchema.safeParse({ total: 1, byStatus: { ...byStatus, draft: -1 } }).success,
    ).toBe(false);
  });

  it('carries the worth per status and currency, and still accepts an API that sends none', () => {
    const byStatus = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, 0]));
    const amounts = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, []]));
    const worth = { ...amounts, submitted: [{ currency: 'NPR', total: '245000.00' }] };
    expect(QuotationSummarySchema.safeParse({ total: 1, byStatus, amounts: worth }).success).toBe(
      true,
    );
    expect(QuotationSummarySchema.safeParse({ total: 0, byStatus }).success).toBe(true);
    const bad = { ...amounts, sent: [{ currency: 'NPR', total: '1.234' }] };
    expect(QuotationSummarySchema.safeParse({ total: 0, byStatus, amounts: bad }).success).toBe(
      false,
    );
    const noStatus = { ...amounts } as Record<string, unknown>;
    delete noStatus['draft'];
    expect(
      QuotationSummarySchema.safeParse({ total: 0, byStatus, amounts: noStatus }).success,
    ).toBe(false);
  });
});

describe('QuotationDetailSchema', () => {
  const iso = '2026-11-08T10:00:00+05:45';
  const parent = () => ({
    id: id(),
    number: 'QT-2082-0042',
    customerId: id(),
    opportunityId: id(),
    currentVersionId: id(),
    ownerUserId: null,
    status: 'draft',
    version: 1,
    createdAt: iso,
    updatedAt: iso,
  });
  const detail = () => ({
    quotation: parent(),
    versions: [],
    statusHistory: [
      {
        versionId: id(),
        fromStatus: null,
        toStatus: 'draft',
        actorId: id(),
        reason: null,
        at: iso,
      },
    ],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [{ id: id(), name: 'Jules Winnfield', email: 'jules@example.com' }],
    capabilities: { canEdit: false, canRevise: true },
  });

  it('parses the parent, versions, history, customer name and contacts', () => {
    expect(QuotationDetailSchema.safeParse(detail()).success).toBe(true);
  });

  it('lets a contact have no email (the send dialog shows it as unusable)', () => {
    expect(
      QuotationDetailSchema.safeParse({
        ...detail(),
        contacts: [{ id: id(), name: 'Vincent', email: null }],
      }).success,
    ).toBe(true);
  });

  it('refuses a missing history, a bad history status and a contact without an id', () => {
    const { statusHistory: _omitted, ...without } = detail();
    expect(QuotationDetailSchema.safeParse(without).success).toBe(false);
    const d = detail();
    expect(
      QuotationDetailSchema.safeParse({
        ...d,
        statusHistory: [{ ...d.statusHistory[0], toStatus: 'lost' }],
      }).success,
    ).toBe(false);
    expect(
      QuotationDetailSchema.safeParse({ ...d, contacts: [{ name: 'x', email: null }] }).success,
    ).toBe(false);
  });

  it('needs the caller capabilities, so a screen never guesses Edit or Revise', () => {
    const { capabilities: _omitted, ...without } = detail();
    expect(QuotationDetailSchema.safeParse(without).success).toBe(false);
    expect(
      QuotationDetailSchema.safeParse({ ...detail(), capabilities: { canEdit: true } }).success,
    ).toBe(false);
  });

  it('carries a lead only when the viewer may read one; no lead and a hidden lead are both absent, never null (D35)', () => {
    const lead = { id: id(), name: 'Website redesign enquiry' };
    const withLead = QuotationDetailSchema.parse({ ...detail(), lead });
    expect(withLead.lead).toEqual(lead);
    expect(QuotationDetailSchema.safeParse({ ...detail(), lead: null }).success).toBe(false);
    const hidden = QuotationDetailSchema.parse(detail());
    expect('lead' in hidden).toBe(false);
  });

  it('refuses a lead without an id or a name, and one that carries more than the id and name', () => {
    expect(QuotationDetailSchema.safeParse({ ...detail(), lead: { name: 'No id' } }).success).toBe(
      false,
    );
    expect(QuotationDetailSchema.safeParse({ ...detail(), lead: { id: id() } }).success).toBe(
      false,
    );
    expect(
      QuotationDetailSchema.safeParse({
        ...detail(),
        lead: { id: id(), name: 'x', ownerUserId: id() },
      }).success,
    ).toBe(false);
  });
});

describe('PaymentMilestoneDtoSchema (D36)', () => {
  const milestone = { label: 'Advance', percent: '33.3333', dueDescription: 'On order' };

  it('is the draft milestone plus a two-decimal amount', () => {
    expect(PaymentMilestoneDtoSchema.safeParse({ ...milestone, amount: '333.33' }).success).toBe(
      true,
    );
    expect(
      PaymentMilestoneDtoSchema.safeParse({ label: 'x', percent: '100', amount: '0.00' }).success,
    ).toBe(true);
  });

  it('refuses a row without an amount, or with an amount that is not money', () => {
    expect(PaymentMilestoneDtoSchema.safeParse(milestone).success).toBe(false);
    expect(PaymentMilestoneDtoSchema.safeParse({ ...milestone, amount: '333.333' }).success).toBe(
      false,
    );
    expect(PaymentMilestoneDtoSchema.safeParse({ ...milestone, amount: 333.33 }).success).toBe(
      false,
    );
  });

  it('leaves the draft input milestone amount-free: an amount is refused, never stored', () => {
    expect(PaymentMilestoneSchema.safeParse(milestone).success).toBe(true);
    expect(PaymentMilestoneSchema.safeParse({ ...milestone, amount: '333.33' }).success).toBe(
      false,
    );
  });
});

describe('QuotationApprovalSnapshotSchema', () => {
  const snapshot = () => ({
    nprTotal: '2690999.99',
    effectiveDiscountPct: '13.0000',
    marginPct: '22.5000',
    nprDiscountAmount: '400000.00',
    currency: 'USD',
    fxRate: '133.500000',
    customerName: 'Big Kahuna Burger Ltd.',
    quotationNumber: 'QT-2082-0042',
    revisionNo: 2,
    discountApprovalRequired: true,
  });

  it('parses the camelCase snapshot with money and percentages as strings', () => {
    expect(QuotationApprovalSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it('allows an unknown margin (no cost recorded) and an NPR document at rate 1', () => {
    expect(
      QuotationApprovalSnapshotSchema.safeParse({
        ...snapshot(),
        marginPct: null,
        currency: 'NPR',
        fxRate: '1',
      }).success,
    ).toBe(true);
  });

  it('refuses numbers for money and percentages, snake_case keys and a zero revision', () => {
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...snapshot(), nprTotal: 2690999.99 }).success,
    ).toBe(false);
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...snapshot(), effectiveDiscountPct: 13 })
        .success,
    ).toBe(false);
    const { nprTotal, ...rest } = snapshot();
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...rest, npr_total: nprTotal }).success,
    ).toBe(false);
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...snapshot(), revisionNo: 0 }).success,
    ).toBe(false);
  });

  it('requires the server flag, a boolean, so the 12% rule is never re-derived from text', () => {
    const { discountApprovalRequired, ...rest } = snapshot();
    expect(discountApprovalRequired).toBe(true);
    expect(QuotationApprovalSnapshotSchema.safeParse(rest).success).toBe(false);
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...snapshot(), discountApprovalRequired: 'true' })
        .success,
    ).toBe(false);
    expect(
      QuotationApprovalSnapshotSchema.safeParse({ ...snapshot(), discountApprovalRequired: false })
        .success,
    ).toBe(true);
  });

  it('is what the inbox renderer reads: a stored JSON snapshot round-trips', () => {
    const stored = JSON.parse(JSON.stringify(snapshot())) as unknown;
    expect(QuotationApprovalSnapshotSchema.parse(stored)).toEqual(snapshot());
  });
});

describe('UpdateQuotationDraftBodySchema clears with null', () => {
  const cleared = [
    'contactId',
    'scope',
    'assumptions',
    'exclusions',
    'termsAndConditions',
    'deliveryTimeline',
    'paymentTermId',
    'discount',
    'paymentSchedule',
  ] as const;

  it.each(cleared)('accepts %s: null, meaning "clear the saved value"', (key) => {
    const parsed = UpdateQuotationDraftBodySchema.safeParse({ expectedVersion: 2, [key]: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.[key]).toBeNull();
  });

  it('limits termsAndConditions to 10000 characters, like exclusions, and trims it', () => {
    const body = (termsAndConditions: string) =>
      UpdateQuotationDraftBodySchema.safeParse({ expectedVersion: 2, termsAndConditions });
    expect(body('x'.repeat(10000)).success).toBe(true);
    expect(body('x'.repeat(10001)).success).toBe(false);
    expect(body('  Net 30  ').data?.termsAndConditions).toBe('Net 30');
  });

  it('accepts an empty payment schedule as a clear too', () => {
    expect(
      UpdateQuotationDraftBodySchema.safeParse({ expectedVersion: 2, paymentSchedule: [] }).success,
    ).toBe(true);
  });

  it('keeps null out of the required fields and out of create', () => {
    for (const key of ['currency', 'issueDate', 'validUntil', 'lines', 'templateId']) {
      expect(
        UpdateQuotationDraftBodySchema.safeParse({ expectedVersion: 2, [key]: null }).success,
      ).toBe(false);
    }
    const create = {
      opportunityId: id(),
      currency: 'NPR',
      issueDate: '2026-11-08',
      validUntil: '2026-11-23',
      lines: [{ description: 'x', uom: 'lot', quantity: '1', unitPrice: '1', taxCodeId: id() }],
    };
    expect(CreateQuotationBodySchema.safeParse(create).success).toBe(true);
    for (const key of cleared) {
      expect(CreateQuotationBodySchema.safeParse({ ...create, [key]: null }).success).toBe(false);
    }
    expect(QuotationVersionContentSchema.safeParse({ ...create, discount: null }).success).toBe(
      false,
    );
  });
});

describe('quote builder lookups and preview', () => {
  it('TaxCodeSchema keeps the {id, label, rate?} shape and allows the registry fields', () => {
    const tid = id();
    expect(TaxCodeSchema.parse({ id: tid, label: 'VAT 13%', rate: '13' })).toEqual({
      id: tid,
      label: 'VAT 13%',
      rate: '13',
    });
    const full = { id: tid, label: 'VAT 13%', code: 'VAT13', kind: 'vat', rateBp: 1300 };
    expect(TaxCodeSchema.parse(full)).toEqual(full);
    expect(TaxCodeSchema.safeParse({ id: tid, label: 'x', kind: 'sales' }).success).toBe(false);
    expect(TaxCodeSchema.safeParse({ id: tid, label: 'x', rateBp: 10001 }).success).toBe(false);
    expect(TaxCodeSchema.safeParse({ id: 'nope', label: 'x' }).success).toBe(false);
  });

  it('PaymentTermSchema is {id, label}', () => {
    const tid = id();
    expect(PaymentTermSchema.parse({ id: tid, label: 'Net 15' })).toEqual({
      id: tid,
      label: 'Net 15',
    });
    expect(PaymentTermSchema.safeParse({ id: tid }).success).toBe(false);
  });

  it('PreviewResultSchema needs totals, tax summary and the approval route', () => {
    expect(PreviewResultSchema.safeParse({ totals: {}, taxSummary: [] }).success).toBe(false);
    expect(PreviewResultSchema.safeParse({}).success).toBe(false);
  });

  it('UpdateQuotationVersionBodySchema is the PUT body: partial content plus expectedVersion', () => {
    expect(UpdateQuotationVersionBodySchema).toBe(UpdateQuotationDraftBodySchema);
    expect(UpdateQuotationVersionBodySchema.safeParse({ notes: 'x' }).success).toBe(false);
    expect(UpdateQuotationVersionBodySchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(UpdateQuotationVersionBodySchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
  });
});

describe('AcceptanceDtoSchema', () => {
  const dto = {
    id: id(),
    versionId: id(),
    outcome: 'accepted',
    actorKind: 'customer_user',
    actorId: id(),
    decidedOn: '2026-11-09',
    comment: null,
    evidenceKinds: ['signed_quote'],
    evidenceDocumentIds: [id()],
  };

  it('carries the name the customer signed with, or null when there is none', () => {
    const named = AcceptanceDtoSchema.safeParse({ ...dto, acceptedByName: 'Sita Sharma' });
    expect(named.success).toBe(true);
    expect(named.success && named.data.acceptedByName).toBe('Sita Sharma');
    expect(AcceptanceDtoSchema.safeParse({ ...dto, acceptedByName: null }).success).toBe(true);
  });

  it('needs acceptedByName to be present (null, not missing) so the column is always read', () => {
    expect(AcceptanceDtoSchema.safeParse(dto).success).toBe(false);
  });
});
