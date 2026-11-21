// Tests for the P3 sales and invoicing contracts: permissions and grants, error codes, the
// `sales.default_schedule` setting, and the sales, invoicing and receivables DTOs. The key promise is
// plan A8: paid is derived from allocations and stored nowhere, so no schema has a `paid` field.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_KEYS, type Permission } from './authz.js';
import { BILLING_ERROR_CODES, BillingErrorCodeSchema, ErrorBodySchema } from './error.js';
import * as invoicing from './invoicing.js';
import * as receivables from './receivables.js';
import * as sales from './sales.js';
import { P3_SETTING_DEFAULTS, SETTING_KEYS, SETTINGS } from './settings.js';
import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from './portal.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-11-09T04:15:00+05:45';
const npr = { amountNpr: '1130.00', rate: '1', rateSource: 'NRB', rateDate: '2026-11-09' };
const party = { legalName: 'Acme Pvt Ltd', panVatNo: '123456789', address: 'Kathmandu' };

// ---------------------------------------------------------------------------------------------
// Permissions and grants
// ---------------------------------------------------------------------------------------------

const P3_PERMISSIONS: readonly Permission[] = [
  'sales_order.read',
  'sales_order.confirm',
  'sales_order.mark_billable',
  'invoice.read',
  'invoice.draft',
  'invoice.submit',
  'invoice.issue',
  'invoice.credit_note',
  'payment.read',
  'payment.record',
  'payment.verify',
  'payment.allocate',
  'ar.read',
  'portal.invoice.read',
  'portal.payment.submit',
];
const PORTAL_PERMISSIONS: readonly Permission[] = ['portal.invoice.read', 'portal.payment.submit'];
const STAFF_PERMISSIONS = P3_PERMISSIONS.filter((p) => !PORTAL_PERMISSIONS.includes(p));

describe('P3 permissions', () => {
  it.each(P3_PERMISSIONS)('lists %s once and gives founder scope all', (permission) => {
    expect(PERMISSIONS.filter((p) => p === permission)).toHaveLength(1);
    expect(DEFAULT_ROLE_PERMISSIONS.founder[permission]).toBe('all');
  });

  it('lets Finance do everything but at scope all, including issue, credit note and verify', () => {
    for (const p of STAFF_PERMISSIONS) expect(DEFAULT_ROLE_PERMISSIONS.finance[p], p).toBe('all');
  });

  it('lets the Accountant prepare but not issue, credit or verify (maker and checker differ)', () => {
    const { accountant } = DEFAULT_ROLE_PERMISSIONS;
    for (const p of [
      'sales_order.read',
      'sales_order.confirm',
      'sales_order.mark_billable',
      'invoice.read',
      'invoice.draft',
      'invoice.submit',
      'payment.read',
      'payment.record',
      'payment.allocate',
      'ar.read',
    ] as const) {
      expect(accountant[p], p).toBe('all');
    }
    for (const p of ['invoice.issue', 'invoice.credit_note', 'payment.verify'] as const) {
      expect(accountant[p], p).toBeUndefined();
    }
  });

  it('lets management read everything and change nothing', () => {
    const { management } = DEFAULT_ROLE_PERMISSIONS;
    for (const p of ['sales_order.read', 'invoice.read', 'payment.read', 'ar.read'] as const) {
      expect(management[p], p).toBe('all');
    }
    for (const p of STAFF_PERMISSIONS.filter((x) => !x.endsWith('.read'))) {
      expect(management[p], p).toBeUndefined();
    }
  });

  it('gives the customer portal role the two portal grants, at its own company, and nothing else', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.customer_user).toMatchObject({
      'portal.invoice.read': 'customer_org',
      'portal.payment.submit': 'customer_org',
    });
    for (const p of STAFF_PERMISSIONS) {
      expect(DEFAULT_ROLE_PERMISSIONS.customer_user[p], p).toBeUndefined();
    }
  });

  it.each(PORTAL_PERMISSIONS)('gives no staff role the portal permission %s', (permission) => {
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (role !== 'founder' && role !== 'customer_user') {
        expect(grants[permission], role).toBeUndefined();
      }
    }
  });

  it('gives sales, vendor and the warehouse-side roles none of the P3 permissions (deny by default)', () => {
    for (const role of ROLE_KEYS) {
      if (['founder', 'management', 'finance', 'accountant', 'customer_user'].includes(role))
        continue;
      for (const p of P3_PERMISSIONS) {
        // D23: Sales reads the sales orders that come from its own quotations.
        if (role === 'sales' && p === 'sales_order.read') continue;
        expect(DEFAULT_ROLE_PERMISSIONS[role][p], `${role} ${p}`).toBeUndefined();
      }
    }
  });

  it('gives the credit-limit permission to Founder and Finance only, at all (not Management)', () => {
    expect(PERMISSIONS.filter((p) => p === 'customers.credit_limit.write')).toHaveLength(1);
    for (const role of ROLE_KEYS) {
      const expected = role === 'founder' || role === 'finance' ? 'all' : undefined;
      expect(DEFAULT_ROLE_PERMISSIONS[role]['customers.credit_limit.write'], role).toBe(expected);
    }
  });

  it('gives the customer-owner permission to Founder and Management only, at all (not Finance)', () => {
    expect(PERMISSIONS.filter((p) => p === 'customers.owner.write')).toHaveLength(1);
    for (const role of ROLE_KEYS) {
      const expected = role === 'founder' || role === 'management' ? 'all' : undefined;
      expect(DEFAULT_ROLE_PERMISSIONS[role]['customers.owner.write'], role).toBe(expected);
    }
  });

  it('lets sales read only its own sales orders (D23)', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.sales['sales_order.read']).toBe('own');
  });
});

// F1-Q32 (R4c1 Q4): kept out of P3_PERMISSIONS because Management holds it, unlike every other P3 change grant.
describe('delivery-hold release permission', () => {
  const RELEASERS = ['founder', 'management', 'finance'] as const;

  it('is listed once', () => {
    expect(PERMISSIONS.filter((p) => p === 'sales_order.delivery_release')).toHaveLength(1);
  });

  it.each(RELEASERS)('gives %s scope all', (role) => {
    expect(DEFAULT_ROLE_PERMISSIONS[role]['sales_order.delivery_release']).toBe('all');
  });

  it('gives no other role it, the Accountant included (it confirms orders but does not release them)', () => {
    for (const role of ROLE_KEYS) {
      if ((RELEASERS as readonly string[]).includes(role)) continue;
      expect(DEFAULT_ROLE_PERMISSIONS[role]['sales_order.delivery_release'], role).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Error codes and the schedule setting
// ---------------------------------------------------------------------------------------------

describe('P3 error codes', () => {
  it('lists the codes the plan uses, each with its HTTP status', () => {
    expect(BILLING_ERROR_CODES).toMatchObject({
      SCHEDULE_LINE_TAKEN: 409,
      OVER_ALLOCATION: 409,
      MISMATCHED_ITEMS: 409,
      already_issued: 200,
      fx_rate_stale: 409,
      evidence_policy_unmet: 422,
      credit_hold: 409,
    });
  });

  it('accepts those codes and refuses an unknown one', () => {
    for (const code of Object.keys(BILLING_ERROR_CODES)) {
      expect(BillingErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
    expect(BillingErrorCodeSchema.safeParse('PAID_IN_FULL').success).toBe(false);
  });

  it('fits the error body, with facts in details', () => {
    const body = {
      error: {
        code: 'fx_rate_stale',
        message: 'The USD rate is older than 7 days.',
        correlationId: 'c-1',
        details: { currency: 'USD', rateDate: '2026-10-30', limitDays: 7 },
      },
    };
    expect(ErrorBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('sales.default_schedule setting', () => {
  const schema = SETTINGS['sales.default_schedule'];
  const line = (percent: string, trigger = 'milestone') => ({
    label: `L ${percent}`,
    percent,
    trigger,
  });

  it('is a setting key and defaults to 60/20/20', () => {
    expect(SETTING_KEYS).toContain('sales.default_schedule');
    expect(P3_SETTING_DEFAULTS['sales.default_schedule'].map((l) => l.percent)).toEqual([
      '60',
      '20',
      '20',
    ]);
    expect(P3_SETTING_DEFAULTS['sales.default_schedule'][0]?.trigger).toBe('advance');
    expect(schema.safeParse(P3_SETTING_DEFAULTS['sales.default_schedule']).success).toBe(true);
  });

  it.each([
    [[line('50'), line('50')]],
    [[line('100', 'advance')]],
    [[line('33.33'), line('33.33'), line('33.34')]],
    [[line('33.3333'), line('33.3333'), line('33.3334')]],
  ])('accepts slices that add up to 100: %j', (value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['empty', []],
    ['adds to 99', [line('60'), line('20'), line('19')]],
    ['adds to 101', [line('60'), line('21'), line('20')]],
    ['over 100 in one slice', [line('101')]],
    ['unknown trigger', [line('50', 'whenever'), line('50')]],
    ['short by one ten-thousandth', [line('33.3333'), line('33.3333'), line('33.3333')]],
    ['five decimals', [line('33.33330'), line('66.6667')]],
    ['blank label', [{ label: ' ', percent: '100', trigger: 'advance' }]],
  ])('rejects %s', (_name, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------------------------

const scheduleLine = {
  id: id(10),
  salesOrderId: id(1),
  seq: 1,
  label: 'Advance 60%',
  trigger: 'advance',
  percent: '60',
  amount: '678.00',
  status: 'billable',
  billableEvidenceDocumentId: null,
  billableMarkedAt: null,
  invoiceId: null,
};
const orderTotals = {
  subtotal: '1000.00',
  discountAmount: '0.00',
  taxableAmount: '1000.00',
  taxAmount: '130.00',
  total: '1130.00',
};
const order = {
  id: id(1),
  number: 'SO-2083/84-00001',
  fiscalYear: '2083/84',
  customerId: id(2),
  quotationId: id(3),
  quotationVersionId: id(4),
  status: 'confirmed',
  currency: 'NPR',
  totals: orderTotals,
  npr,
  creditDays: 30,
  confirmedAt: at,
  version: 1,
  createdAt: at,
  updatedAt: at,
};

describe('sales order contracts', () => {
  it('has the statuses, triggers and line statuses of the plan', () => {
    expect([...sales.SALES_ORDER_STATUSES]).toEqual([
      'draft',
      'confirmed',
      'completed',
      'cancelled',
    ]);
    expect([...sales.SCHEDULE_LINE_STATUSES]).toEqual([
      'planned',
      'billable',
      'drafted',
      'invoiced',
      'cancelled',
    ]);
    expect(sales.SCHEDULE_TRIGGERS).toContain('advance');
  });

  it('parses a schedule line and ties invoiceId to drafted or invoiced', () => {
    const parse = (o: object) => sales.ScheduleLineDtoSchema.safeParse({ ...scheduleLine, ...o });
    expect(parse({}).success).toBe(true);
    expect(parse({ status: 'drafted', invoiceId: id(20) }).success).toBe(true);
    expect(parse({ status: 'invoiced', invoiceId: id(20) }).success).toBe(true);
    expect(parse({ status: 'drafted' }).success).toBe(false);
    expect(parse({ status: 'billable', invoiceId: id(20) }).success).toBe(false);
    expect(parse({ status: 'paid' }).success).toBe(false);
    expect(parse({ amount: '-1.00' }).success).toBe(false);
  });

  it('parses a confirmed order and demands a number once it is not a draft', () => {
    const parse = (o: object) => sales.SalesOrderDtoSchema.safeParse({ ...order, ...o });
    expect(parse({}).success).toBe(true);
    expect(
      parse({ status: 'draft', number: null, fiscalYear: null, confirmedAt: null }).success,
    ).toBe(true);
    expect(parse({ number: null }).success).toBe(false);
    expect(parse({ confirmedAt: null }).success).toBe(false);
    expect(parse({ currency: 'EUR' }).success).toBe(false);
    expect(parse({ totals: { ...orderTotals, total: '11.305' } }).success).toBe(false);
  });

  it('parses the detail view with deliveryReleased', () => {
    const detail = {
      order,
      lines: [
        {
          lineNo: 1,
          catalogItemId: null,
          description: 'Setup',
          uom: 'job',
          quantity: '1',
          unitPrice: '1000.00',
          taxCodeId: id(5),
          gross: '1000.00',
          discountAlloc: '0.00',
          taxable: '1000.00',
        },
      ],
      schedule: [scheduleLine],
      evidence: [{ documentId: id(6), kind: 'purchase_order' }],
      deliveryReleased: false,
    };
    expect(sales.SalesOrderDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      sales.SalesOrderDetailSchema.safeParse({ ...detail, deliveryReleased: 'no' }).success,
    ).toBe(false);
  });

  it('carries can.releaseSoleEligible (F1-Q11 a) as an optional boolean', () => {
    const detail = {
      order,
      lines: [],
      schedule: [scheduleLine],
      evidence: [],
      deliveryReleased: false,
    };
    const base = { markBillable: false, draftInvoice: false };
    const parse = (can: object) => sales.SalesOrderDetailSchema.safeParse({ ...detail, can });
    const soleEligible = {
      ...base,
      releaseDelivery: true,
      releaseDeliveryBlockedBy: null,
      releaseDeliveryAllowedRoles: ['finance', 'founder'],
      releaseSoleEligible: true,
    };
    const ok = parse(soleEligible);
    expect(ok.success).toBe(true);
    expect(ok.data?.can?.releaseSoleEligible).toBe(true);
    expect(parse({ ...base, releaseSoleEligible: false }).success).toBe(true);
    // Absent reads as false: an older answer without the field still parses.
    expect(parse(base).data?.can?.releaseSoleEligible).toBeUndefined();
    expect(parse({ ...base, releaseSoleEligible: 'yes' }).success).toBe(false);
  });

  it('checks the commands strictly', () => {
    expect(
      sales.ConfirmSalesOrderBodySchema.parse({ quotationVersionId: id(4) }).evidenceDocumentIds,
    ).toEqual([]);
    expect(
      sales.ConfirmSalesOrderBodySchema.safeParse({ quotationVersionId: id(4), total: '1.00' })
        .success,
    ).toBe(false);
    expect(sales.MarkBillableBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(sales.MarkBillableBodySchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(
      sales.ReviseScheduleBodySchema.safeParse({
        lines: [{ label: 'All', percent: '100', trigger: 'delivery' }],
        reason: 'Customer asked for one invoice',
        expectedVersion: 2,
      }).success,
    ).toBe(true);
    expect(
      sales.ReviseScheduleBodySchema.safeParse({
        lines: [{ label: 'Half', percent: '50', trigger: 'delivery' }],
        reason: 'x',
        expectedVersion: 2,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

const invoiceTotals = {
  subtotal: '1000.00',
  discountAmount: '0.00',
  taxableAmount: '1000.00',
  exemptAmount: '0.00',
  zeroRatedAmount: '0.00',
  taxAmount: '130.00',
  total: '1130.00',
};
const draftInvoice = {
  id: id(20),
  kind: 'tax_invoice',
  status: 'draft',
  number: null,
  fiscalYear: null,
  customerId: id(2),
  salesOrderId: id(1),
  scheduleLineId: id(10),
  originalInvoiceId: null,
  manualReason: null,
  noteReason: null,
  currency: 'NPR',
  totals: invoiceTotals,
  npr: null,
  issueDate: null,
  issueDateBs: null,
  dueDate: null,
  seller: null,
  buyer: null,
  calcVersion: 1,
  contentHash: null,
  approvalRequestId: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
};
const issuedInvoice = {
  ...draftInvoice,
  status: 'issued',
  number: 'INV-2083/84-00001',
  fiscalYear: '2083/84',
  npr,
  issueDate: '2026-11-09',
  issueDateBs: '2083-07-23',
  dueDate: '2026-12-09',
  seller: party,
  buyer: party,
  contentHash: 'a'.repeat(64),
};

describe('invoice contracts', () => {
  it('has the kinds and statuses of the plan', () => {
    expect([...invoicing.INVOICE_KINDS]).toEqual([
      'tax_invoice',
      'proforma',
      'credit_note',
      'debit_note',
    ]);
    expect([...invoicing.INVOICE_STATUSES]).toEqual([
      'draft',
      'submitted',
      'returned',
      'approved',
      'issued',
      'discarded',
    ]);
  });

  it('parses a draft and an issued invoice', () => {
    expect(invoicing.InvoiceDtoSchema.safeParse(draftInvoice).success).toBe(true);
    expect(invoicing.InvoiceDtoSchema.safeParse(issuedInvoice).success).toBe(true);
  });

  const parse = (o: object) => invoicing.InvoiceDtoSchema.safeParse(o);
  it.each([
    ['a number on a draft', { ...draftInvoice, number: 'INV-2083/84-00001' }],
    ['issued without a number', { ...issuedInvoice, number: null }],
    ['issued without an issue date', { ...issuedInvoice, issueDate: null }],
    ['issued without a content hash', { ...issuedInvoice, contentHash: null }],
    ['issued without the NPR value', { ...issuedInvoice, npr: null }],
    ['issued without the buyer snapshot', { ...issuedInvoice, buyer: null }],
    [
      'a credit note without an original',
      { ...draftInvoice, kind: 'credit_note', noteReason: 'x' },
    ],
    [
      'a credit note without a reason',
      { ...draftInvoice, kind: 'credit_note', originalInvoiceId: id(21) },
    ],
    ['an original on a tax invoice', { ...draftInvoice, originalInvoiceId: id(21) }],
    ['a tax invoice with neither SO nor manual reason', { ...draftInvoice, salesOrderId: null }],
    ['a submitted proforma', { ...draftInvoice, kind: 'proforma', status: 'submitted' }],
    ['an unknown kind', { ...draftInvoice, kind: 'receipt' }],
    ['an unknown status', { ...draftInvoice, status: 'paid' }],
    ['a bad content hash', { ...issuedInvoice, contentHash: 'abc' }],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('accepts a manual invoice with a reason and a credit note with its original', () => {
    expect(
      parse({ ...draftInvoice, salesOrderId: null, scheduleLineId: null, manualReason: 'One-off' })
        .success,
    ).toBe(true);
    expect(
      parse({
        ...draftInvoice,
        kind: 'credit_note',
        originalInvoiceId: id(21),
        noteReason: 'Returned goods',
        salesOrderId: null,
      }).success,
    ).toBe(true);
    expect(
      parse({
        ...draftInvoice,
        kind: 'proforma',
        status: 'issued',
        ...{
          number: 'PI-2083/84-00001',
          fiscalYear: '2083/84',
          npr,
          issueDate: '2026-11-09',
          issueDateBs: '2083-07-23',
          seller: party,
          buyer: party,
          contentHash: 'b'.repeat(64),
        },
      }).success,
    ).toBe(true);
  });

  it('allows the transitions of the state machine and nothing else', () => {
    const can = invoicing.canTransitionInvoice;
    expect(can('tax_invoice', 'draft', 'submitted')).toBe(true);
    expect(can('tax_invoice', 'submitted', 'returned')).toBe(true);
    expect(can('tax_invoice', 'returned', 'submitted')).toBe(true);
    expect(can('tax_invoice', 'approved', 'issued')).toBe(true);
    expect(can('tax_invoice', 'approved', 'draft')).toBe(true);
    expect(can('tax_invoice', 'draft', 'issued')).toBe(false);
    expect(can('tax_invoice', 'issued', 'draft')).toBe(false);
    expect(can('tax_invoice', 'issued', 'discarded')).toBe(false);
    expect(can('credit_note', 'draft', 'issued')).toBe(false);
    expect(can('proforma', 'draft', 'issued')).toBe(true);
    expect(can('proforma', 'draft', 'submitted')).toBe(false);
    expect(invoicing.isInvoiceEditable('returned')).toBe(true);
    expect(invoicing.isInvoiceEditable('approved')).toBe(false);
  });

  const line = {
    description: 'Setup',
    uom: 'job',
    quantity: '1',
    unitPrice: '1000.00',
    taxCodeId: id(5),
  };
  it('checks the commands strictly and never takes a number, date or total from the client', () => {
    expect(
      invoicing.DraftFromScheduleBodySchema.safeParse({ scheduleLineId: id(10) }).success,
    ).toBe(true);
    expect(
      invoicing.CreateManualInvoiceBodySchema.safeParse({
        customerId: id(2),
        currency: 'USD',
        manualReason: 'One-off',
        lines: [line],
      }).success,
    ).toBe(true);
    expect(
      invoicing.CreateManualInvoiceBodySchema.safeParse({
        customerId: id(2),
        currency: 'USD',
        lines: [line],
      }).success,
    ).toBe(false);
    expect(
      invoicing.CreateManualInvoiceBodySchema.safeParse({
        customerId: id(2),
        currency: 'USD',
        manualReason: 'One-off',
        discount: { mode: 'pct', value: '5.00' },
        lines: [line],
      }).success,
    ).toBe(true);
    expect(
      invoicing.CreateManualInvoiceBodySchema.safeParse({
        customerId: id(2),
        currency: 'USD',
        manualReason: 'One-off',
        discount: { mode: 'pct', value: '150.00' },
        lines: [line],
      }).success,
    ).toBe(false);
    for (const forged of [
      { number: 'INV-1' },
      { issueDate: '2026-01-01' },
      { total: '1.00' },
      { contentHash: 'a'.repeat(64) },
    ]) {
      expect(
        invoicing.CreateManualInvoiceBodySchema.safeParse({
          customerId: id(2),
          currency: 'NPR',
          manualReason: 'x',
          lines: [line],
          ...forged,
        }).success,
      ).toBe(false);
      expect(
        invoicing.UpdateInvoiceDraftBodySchema.safeParse({ expectedVersion: 1, ...forged }).success,
      ).toBe(false);
    }
    expect(
      invoicing.CreateManualInvoiceBodySchema.safeParse({
        customerId: id(2),
        currency: 'NPR',
        manualReason: 'x',
        lines: [],
      }).success,
    ).toBe(false);
    expect(invoicing.SubmitInvoiceBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(invoicing.DiscardInvoiceBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
  });

  it('answers an issue with issued or already_issued, carrying the same number', () => {
    const base = { invoiceId: id(20), number: 'INV-2083/84-00001' };
    expect(invoicing.IssueInvoiceResultSchema.safeParse({ kind: 'issued', ...base }).success).toBe(
      true,
    );
    expect(
      invoicing.IssueInvoiceResultSchema.safeParse({ kind: 'already_issued', ...base }).success,
    ).toBe(true);
    expect(
      invoicing.IssueInvoiceResultSchema.safeParse({ kind: 'rejected', ...base }).success,
    ).toBe(false);
    expect(
      invoicing.IssueInvoiceResultSchema.safeParse({ kind: 'issued', invoiceId: id(20) }).success,
    ).toBe(false);
  });

  it('checks credit and debit note bodies', () => {
    const credit = {
      originalInvoiceId: id(20),
      reason: 'Returned',
      lines: [{ originalLineNo: 1, quantity: '1' }],
    };
    expect(invoicing.CreditNoteBodySchema.safeParse(credit).success).toBe(true);
    expect(invoicing.CreditNoteBodySchema.safeParse({ ...credit, lines: [] }).success).toBe(false);
    expect(
      invoicing.CreditNoteBodySchema.safeParse({
        ...credit,
        lines: [
          { originalLineNo: 1, quantity: '1' },
          { originalLineNo: 1, quantity: '2' },
        ],
      }).success,
    ).toBe(false);
    expect(invoicing.CreditNoteBodySchema.safeParse({ ...credit, reason: ' ' }).success).toBe(
      false,
    );
    expect(
      invoicing.DebitNoteBodySchema.safeParse({
        originalInvoiceId: id(20),
        reason: 'Freight',
        lines: [line],
      }).success,
    ).toBe(true);
  });

  const view = {
    id: id(20),
    kind: 'tax_invoice',
    number: 'INV-2083/84-00001',
    issueDate: '2026-11-09',
    issueDateBs: '2083-07-23',
    dueDate: null,
    currency: 'NPR',
    seller: party,
    buyer: party,
    lines: [
      {
        lineNo: 1,
        description: 'Setup',
        uom: 'job',
        quantity: '1',
        unitPrice: '1000.00',
        amount: '1000.00',
      },
    ],
    totals: {
      subtotal: '1000.00',
      discountAmount: '0.00',
      taxableAmount: '1000.00',
      taxAmount: '130.00',
      total: '1130.00',
    },
    taxSummary: [{ label: 'VAT 13%', percent: '13', base: '1000.00', tax: '130.00' }],
    file: null,
  };
  it('keeps the customer view strict and free of internal words', () => {
    expect(invoicing.CustomerInvoiceViewSchema.safeParse(view).success).toBe(true);
    expect(invoicing.CustomerInvoiceViewSchema.safeParse({ ...view, npr }).success).toBe(false);
    expect(
      invoicing.CustomerInvoiceViewSchema.safeParse({ ...view, kind: 'proforma' }).success,
    ).toBe(false);
    for (const schema of [
      invoicing.CustomerInvoiceViewSchema,
      invoicing.PortalInvoiceListItemSchema,
    ]) {
      // `format.numberSystems` is keyed by currency code (the first print's grouping per currency), so the
      // upper-case code NPR is a customer-safe key. A lower-case `npr` field (the internal NPR value) still fails.
      const leaks = schemaKeys(schema)
        .filter((k) => k !== 'NPR')
        .filter((k) => words(k).some((w) => CUSTOMER_VIEW_FORBIDDEN_WORDS.includes(w)));
      expect(leaks).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Payments, allocations and aging
// ---------------------------------------------------------------------------------------------

const submittedPayment = {
  id: id(30),
  customerId: id(2),
  status: 'submitted',
  method: 'bank_transfer',
  currency: 'NPR',
  amount: '1000.00',
  tdsWithheld: '100.00',
  withholdingCode: 'TDS_SERVICE',
  settles: '1100.00',
  receivedOn: '2026-11-08',
  bankReference: 'TXN-1',
  npr: null,
  submittedBy: id(40),
  submittedVia: 'portal',
  verifiedBy: null,
  verifiedAt: null,
  rejectionReason: null,
  number: null,
  fiscalYear: null,
  proofDocumentIds: [id(50)],
  unallocatedAmount: '0.00',
  version: 1,
  createdAt: at,
  updatedAt: at,
};
const verifiedPayment = {
  ...submittedPayment,
  status: 'verified',
  npr,
  verifiedBy: id(41),
  verifiedAt: at,
  number: 'RCPT-2083/84-00001',
  fiscalYear: '2083/84',
  unallocatedAmount: '1100.00',
};

describe('payment contracts', () => {
  it('has the statuses of the plan and the transitions between them', () => {
    expect([...receivables.PAYMENT_STATUSES]).toEqual([
      'submitted',
      'verified',
      'rejected',
      'withdrawn',
      'reversed',
    ]);
    expect(receivables.PAYMENT_TRANSITIONS.submitted).toEqual([
      'verified',
      'rejected',
      'withdrawn',
    ]);
    expect(receivables.PAYMENT_TRANSITIONS.verified).toEqual(['reversed']);
    expect(receivables.PAYMENT_TRANSITIONS.rejected).toEqual([]);
  });

  const parse = (o: object) => receivables.PaymentDtoSchema.safeParse(o);
  it('parses a submitted and a verified payment', () => {
    expect(parse(submittedPayment).success).toBe(true);
    expect(parse(verifiedPayment).success).toBe(true);
    expect(
      parse({ ...submittedPayment, status: 'rejected', rejectionReason: 'Wrong amount' }).success,
    ).toBe(true);
    expect(parse({ ...verifiedPayment, status: 'reversed' }).success).toBe(true);
  });

  it.each([
    ['a rejection without a reason', { ...submittedPayment, status: 'rejected' }],
    ['a verified payment without a receipt number', { ...verifiedPayment, number: null }],
    [
      'a receipt number on a submitted payment',
      { ...submittedPayment, number: 'RCPT-2083/84-00001' },
    ],
    ['the submitter as verifier', { ...verifiedPayment, verifiedBy: id(40) }],
    ['a zero amount', { ...submittedPayment, amount: '0.00' }],
    ['a negative tax withheld', { ...submittedPayment, tdsWithheld: '-1.00' }],
    ['an unknown method', { ...submittedPayment, method: 'barter' }],
    ['an unknown status', { ...submittedPayment, status: 'paid' }],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  const staffBody = {
    customerId: id(2),
    currency: 'NPR',
    amount: '1000.00',
    method: 'cheque',
    receivedOn: '2026-11-08',
    proofDocumentIds: [id(50)],
  };
  const { customerId: _omit, ...portalBody } = staffBody;
  it('checks the staff and portal submit bodies', () => {
    expect(receivables.SubmitPaymentBodySchema.parse(staffBody).tdsWithheld).toBe('0.00');
    expect(receivables.PortalSubmitPaymentBodySchema.safeParse(portalBody).success).toBe(true);
    // The portal customer comes from the principal: a body that names one is refused.
    expect(
      receivables.PortalSubmitPaymentBodySchema.safeParse({ ...portalBody, customerId: id(2) })
        .success,
    ).toBe(false);
    expect(
      receivables.SubmitPaymentBodySchema.safeParse({ ...staffBody, proofDocumentIds: [] }).success,
    ).toBe(false);
    expect(
      receivables.SubmitPaymentBodySchema.safeParse({ ...staffBody, amount: '1000.001' }).success,
    ).toBe(false);
    expect(
      receivables.SubmitPaymentBodySchema.safeParse({ ...staffBody, tdsWithheld: '50.00' }).success,
    ).toBe(false);
    expect(
      receivables.SubmitPaymentBodySchema.safeParse({
        ...staffBody,
        tdsWithheld: '50.00',
        withholdingCode: 'TDS_SERVICE',
      }).success,
    ).toBe(true);
    expect(
      receivables.SubmitPaymentBodySchema.safeParse({ ...staffBody, status: 'verified' }).success,
    ).toBe(false);
  });

  it('checks verify, reject, withdraw and reverse', () => {
    expect(receivables.VerifyPaymentBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(
      true,
    );
    expect(receivables.RejectPaymentBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
    expect(
      receivables.RejectPaymentBodySchema.safeParse({ expectedVersion: 1, reason: 'Blurry' })
        .success,
    ).toBe(true);
    expect(receivables.WithdrawPaymentBodySchema.safeParse({ expectedVersion: 1 }).success).toBe(
      true,
    );
    expect(
      receivables.ReversePaymentBodySchema.safeParse({ expectedVersion: 1, reason: 'Bounced' })
        .success,
    ).toBe(true);
  });
});

describe('allocation contracts', () => {
  const alloc = {
    id: id(60),
    invoiceId: id(20),
    paymentId: id(30),
    creditNoteId: null,
    amount: '500.00',
    reversesAllocationId: null,
    reason: null,
    createdBy: id(41),
    createdAt: at,
  };
  const parse = (o: object) => receivables.AllocationDtoSchema.safeParse(o);

  it('parses an allocation and its reversal', () => {
    expect(parse(alloc).success).toBe(true);
    expect(parse({ ...alloc, paymentId: null, creditNoteId: id(21) }).success).toBe(true);
    expect(
      parse({
        ...alloc,
        id: id(61),
        amount: '-500.00',
        reversesAllocationId: id(60),
        reason: 'Wrong invoice',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['both sources', { ...alloc, creditNoteId: id(21) }],
    ['no source', { ...alloc, paymentId: null }],
    ['a zero amount', { ...alloc, amount: '0.00' }],
    ['a negative amount that reverses nothing', { ...alloc, amount: '-5.00' }],
    ['a reversal with a positive amount', { ...alloc, reversesAllocationId: id(62) }],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('checks the allocate body: one line per invoice, amounts above zero', () => {
    const lines = [{ invoiceId: id(20), amount: '500.00' }];
    expect(receivables.AllocatePaymentBodySchema.safeParse({ lines }).success).toBe(true);
    expect(receivables.AllocatePaymentBodySchema.safeParse({ lines: [] }).success).toBe(false);
    expect(
      receivables.AllocatePaymentBodySchema.safeParse({ lines: [...lines, ...lines] }).success,
    ).toBe(false);
    expect(
      receivables.AllocatePaymentBodySchema.safeParse({
        lines: [{ invoiceId: id(20), amount: '-5.00' }],
      }).success,
    ).toBe(false);
    expect(
      receivables.AllocatePaymentBodySchema.safeParse({
        lines: [{ invoiceId: id(20), amount: '0.00' }],
      }).success,
    ).toBe(false);
    expect(receivables.DeallocateBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('receivables read models', () => {
  const buckets = {
    current: '100.00',
    d1_30: '0.00',
    d31_60: '50.00',
    d61_90: '0.00',
    d91_plus: '0.00',
  };

  it('parses an invoice settlement, an advance and an aging report', () => {
    const settlement = {
      invoiceId: id(20),
      number: 'INV-2083/84-00001',
      kind: 'tax_invoice',
      customerId: id(2),
      currency: 'NPR',
      issueDate: '2026-11-09',
      total: '1130.00',
      allocatedAmount: '500.00',
      openAmount: '630.00',
      dueDate: '2026-12-09',
      daysOverdue: 0,
      settlement: 'partly_paid',
    };
    expect(receivables.InvoiceSettlementSchema.safeParse(settlement).success).toBe(true);
    expect(
      receivables.InvoiceSettlementSchema.safeParse({ ...settlement, kind: 'receipt' }).success,
    ).toBe(false);
    expect(
      receivables.InvoiceSettlementSchema.safeParse({ ...settlement, issueDate: undefined })
        .success,
    ).toBe(false);
    expect(
      receivables.CustomerAdvanceSchema.safeParse({
        customerId: id(2),
        currency: 'NPR',
        amount: '10.00',
      }).success,
    ).toBe(true);
    const report = {
      asOf: '2026-11-09',
      rows: [
        {
          customerId: id(2),
          customerName: 'Acme',
          currency: 'NPR',
          buckets,
          totalOpen: '150.00',
          promiseMissed: false,
          promiseMissedOn: null,
          promiseMissedInvoice: null,
          openPromiseDate: null,
          openPromiseInvoice: null,
        },
      ],
      totals: [{ currency: 'NPR', buckets, totalOpen: '150.00' }],
    };
    expect(receivables.ArAgingReportSchema.safeParse(report).success).toBe(true);
    expect(receivables.AGING_BUCKETS).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd91_plus']);
    expect(
      receivables.ArAgingReportSchema.safeParse({
        ...report,
        rows: [{ ...report.rows[0], buckets: { ...buckets, d91_plus: undefined } }],
      }).success,
    ).toBe(false);
  });

  it('derives settlement as a status value, with no stored paid state', () => {
    expect([...receivables.SETTLEMENT_STATUSES]).toEqual([
      'unpaid',
      'partly_paid',
      'paid',
      'overdue',
      'credited',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Plan A8: nothing stores "paid"
// ---------------------------------------------------------------------------------------------

const words = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Every property name in a schema, at any depth, read from its JSON Schema (so optional keys count). */
function schemaKeys(schema: z.ZodType): string[] {
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'properties' && v !== null && typeof v === 'object') keys.push(...Object.keys(v));
      walk(v);
    }
  };
  walk(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
  return keys;
}

/** A key stores "paid" when it has the word paid in it, or is the amount_paid / amountpaid family. */
const isPaidKey = (key: string): boolean =>
  words(key).includes('paid') ||
  key
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .includes('amountpaid');

const allSchemas = [sales, invoicing, receivables].flatMap((mod) =>
  Object.entries(mod)
    .filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType)
    .map(([name, schema]) => ({ name, schema })),
);

describe('no paid field anywhere (plan A8)', () => {
  it('walks real schemas: it finds the nested keys it should', () => {
    expect(allSchemas.length).toBeGreaterThan(40);
    expect(schemaKeys(invoicing.InvoiceDetailSchema)).toEqual(
      expect.arrayContaining(['invoice', 'lines', 'totals', 'contentHash', 'taxAmount']),
    );
    expect(schemaKeys(receivables.PaymentDtoSchema)).toContain('unallocatedAmount');
  });

  it('proves the check works: it catches paid keys hidden in nested, optional and nullable places', () => {
    const planted = z.object({
      invoices: z.array(
        z.object({
          ok: z.string(),
          inner: z.object({ amount_paid: z.string() }).nullable().optional(),
        }),
      ),
    });
    expect(schemaKeys(planted).filter(isPaidKey)).toEqual(['amount_paid']);
    for (const key of [
      'paid',
      'isPaid',
      'amountPaid',
      'amount_paid',
      'paidAt',
      'totalPaid',
      'amountpaid',
    ]) {
      expect(isPaidKey(key), key).toBe(true);
    }
    for (const key of [
      'openAmount',
      'allocatedAmount',
      'unpaidAmount',
      'settlement',
      'paymentId',
      'tdsWithheld',
    ]) {
      expect(isPaidKey(key), key).toBe(false);
    }
  });

  it('finds no paid key in any sales, invoicing or receivables schema', () => {
    const found = allSchemas.flatMap(({ name, schema }) =>
      schemaKeys(schema)
        .filter(isPaidKey)
        .map((k) => `${name}.${k}`),
    );
    expect(found).toEqual([]);
  });

  it('refuses a body that tries to set paid, and strips nothing silently', () => {
    expect(
      receivables.AllocatePaymentBodySchema.safeParse({
        lines: [{ invoiceId: id(20), amount: '5.00' }],
        paid: true,
      }).success,
    ).toBe(false);
    expect(invoicing.InvoiceDtoSchema.shape).not.toHaveProperty('paid');
    expect(invoicing.InvoiceDtoSchema.shape).not.toHaveProperty('amountPaid');
  });
});
