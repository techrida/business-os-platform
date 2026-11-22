// P4 contracts: purchases and vendor accounts. The index.ts export lines are added by the lead, so this
// file imports the new modules directly.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_KEYS,
  RoleKeySchema,
  SOD_PERMISSIONS,
  type Permission,
} from './authz.js';
import {
  BILL_STATUSES,
  BILL_TRANSITIONS,
  CreateVendorBillBodySchema,
  PAYMENT_REQUEST_STATUSES,
  PAYMENT_REQUEST_TRANSITIONS,
  PaymentRequestStatusSchema,
  RequestPaymentBodySchema,
  canTransitionBill,
  canTransitionPaymentRequest,
} from './payables.js';
import {
  VENDOR_PORTAL_FORBIDDEN_WORDS,
  VENDOR_VISIBLE_PO_STATUSES,
  VendorPortalBillViewSchema,
  VendorPortalBankViewSchema,
  VendorPortalPurchaseOrderViewSchema,
  forbiddenPortalKeys,
} from './portal-vendor.js';
import {
  ConfirmReceiptBodySchema,
  ConvertSubmissionBodySchema,
  CreatePurchaseRequestBodySchema,
  CreateRfqBodySchema,
  P4_DOCUMENT_TYPES,
  PO_STATUSES,
  PO_TRANSITIONS,
  PR_STATUSES,
  PR_TRANSITIONS,
  RecommendQuotationBodySchema,
  RecordQuotationBodySchema,
  ScoreQuotationBodySchema,
  canTransitionPo,
  canTransitionPr,
} from './procurement.js';
import { P4_SETTING_DEFAULTS, SETTINGS } from './settings.js';
import {
  BANK_ACCOUNT_STATUSES,
  CreateVendorBodySchema,
  ProposeBankAccountBodySchema,
  VENDOR_STATUSES,
  VENDOR_TRANSITIONS,
  VendorBankAccountDtoSchema,
  canTransitionVendor,
} from './vendors.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('P4 permissions', () => {
  const P4: Permission[] = [
    'vendor.read',
    'vendor.write',
    'vendor.activate',
    'vendor.bank.propose',
    'vendor.bank.verify',
    'procurement.pr.create',
    'procurement.pr.read',
    'procurement.sourcing',
    'procurement.po.issue',
    'procurement.receipt.confirm',
    'payables.bill.enter',
    'payables.bill.read',
    'payables.payment.request',
    'payables.vat_register.read',
    'portal.vendor.read',
    'portal.vendor.submit',
  ];

  it.each(P4)('lists %s once, and founder holds it at all', (p) => {
    expect(PERMISSIONS.filter((x) => x === p)).toHaveLength(1);
    expect(DEFAULT_ROLE_PERMISSIONS.founder[p]).toBe('all');
  });

  it('follows decision D03 for roles: no receiver, warehouse and operations_officer exist', () => {
    expect(ROLE_KEYS).not.toContain('receiver');
    expect(RoleKeySchema.safeParse('receiver').success).toBe(false);
    for (const role of ['warehouse', 'operations_officer', 'pmo', 'procurement']) {
      expect(RoleKeySchema.safeParse(role).success).toBe(true);
      expect(DEFAULT_ROLE_PERMISSIONS).toHaveProperty(role);
    }
  });

  it('grants the D03 permissions to the named roles', () => {
    const r = DEFAULT_ROLE_PERMISSIONS;
    expect(r.procurement['procurement.sourcing']).toBe('all');
    expect(r.procurement['procurement.po.issue']).toBe('all');
    expect(r.procurement['vendor.write']).toBe('all');
    expect(r.procurement['vendor.bank.propose']).toBe('all');
    expect(r.warehouse['procurement.receipt.confirm']).toBe('all');
    expect(r.accountant['payables.bill.enter']).toBe('all');
    expect(r.finance['vendor.bank.verify']).toBe('all');
    expect(r.finance['payables.payment.request']).toBe('all');
    expect(r.vendor_user['portal.vendor.read']).toBe('customer_org');
    expect(r.vendor_user['portal.vendor.submit']).toBe('customer_org');
  });

  it('keeps vendor users on portal permissions only', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS.vendor_user).sort()).toEqual([
      'portal.vendor.read',
      'portal.vendor.submit',
    ]);
  });

  it('gives procurement and warehouse no money-approval permission', () => {
    const MONEY_APPROVAL: Permission[] = [
      'approvals.requests.act',
      'approvals.requests.reroute',
      'payables.payment.request',
      'payables.bill.enter',
      'vendor.bank.verify',
      'vendor.activate',
    ];
    for (const role of ['procurement', 'warehouse', 'operations_officer'] as const) {
      for (const p of MONEY_APPROVAL) {
        expect(DEFAULT_ROLE_PERMISSIONS[role][p], `${role} must not hold ${p}`).toBeUndefined();
      }
    }
  });

  it('keeps separation of duties: whoever enters a bill cannot hold bank verification', () => {
    const { accountant, finance } = DEFAULT_ROLE_PERMISSIONS;
    expect(accountant['vendor.bank.verify']).toBeUndefined();
    expect(finance['payables.bill.enter']).toBeUndefined();
    for (const p of SOD_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });

  it('splits the bank maker-checker: procurement proposes, finance verifies, and only founder holds both', () => {
    const r = DEFAULT_ROLE_PERMISSIONS;
    expect(r.procurement['vendor.bank.propose']).toBe('all');
    expect(r.procurement['vendor.bank.verify']).toBeUndefined();
    expect(r.finance['vendor.bank.verify']).toBe('all');
    expect(r.finance['vendor.bank.propose']).toBeUndefined();
    const holdsBoth = Object.entries(r)
      .filter(([, grants]) => grants['vendor.bank.propose'] && grants['vendor.bank.verify'])
      .map(([role]) => role);
    expect(holdsBoth).toEqual(['founder']);
  });
});

describe('P4 settings', () => {
  it('declares the six keys with their defaults', () => {
    expect(P4_SETTING_DEFAULTS).toEqual({
      'procurement.min_quotes': 3,
      'procurement.match.qty_pct': '0',
      'procurement.match.price_pct': '2',
      'procurement.match.price_npr': '500',
      'procurement.band.management_npr': '100000',
      'procurement.band.founder_npr': '1000000',
    });
    for (const key of Object.keys(P4_SETTING_DEFAULTS) as (keyof typeof P4_SETTING_DEFAULTS)[]) {
      expect(SETTINGS[key].safeParse(P4_SETTING_DEFAULTS[key]).success, key).toBe(true);
    }
  });

  it.each([
    ['procurement.min_quotes', 1, true],
    ['procurement.min_quotes', 0, false],
    ['procurement.min_quotes', 2.5, false],
    ['procurement.min_quotes', '3', false],
    ['procurement.match.price_pct', '100', true],
    ['procurement.match.price_pct', '100.01', false],
    ['procurement.match.price_pct', '-1', false],
    ['procurement.match.qty_pct', 0, false],
    ['procurement.match.price_npr', '0', true],
    ['procurement.match.price_npr', '-5', false],
    ['procurement.match.price_npr', '500.123', false],
    ['procurement.band.management_npr', '100000.00', true],
    ['procurement.band.management_npr', '-1', false],
    ['procurement.band.founder_npr', 1000000, false],
  ] as const)('%s accepts %j: %s', (key, value, ok) => {
    expect(SETTINGS[key].safeParse(value).success).toBe(ok);
  });
});

describe('P4 state machines', () => {
  it.each([
    ['vendor', VENDOR_STATUSES, VENDOR_TRANSITIONS],
    ['purchase request', PR_STATUSES, PR_TRANSITIONS],
    ['purchase order', PO_STATUSES, PO_TRANSITIONS],
    ['vendor bill', BILL_STATUSES, BILL_TRANSITIONS],
    ['payment request', PAYMENT_REQUEST_STATUSES, PAYMENT_REQUEST_TRANSITIONS],
  ] as const)('%s: every state has a row and every target is a known state', (_n, states, map) => {
    const known = new Set<string>(states);
    expect(new Set(Object.keys(map))).toEqual(known);
    for (const targets of Object.values(map)) {
      for (const t of targets as readonly string[]) expect(known.has(t)).toBe(true);
    }
  });

  it('lists the payment request statuses exactly', () => {
    expect([...PAYMENT_REQUEST_STATUSES]).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'rejected',
      'cancelled',
    ]);
    expect(PaymentRequestStatusSchema.safeParse('executed').success).toBe(false);
  });

  it('follows the vendor flow of A4 2.4', () => {
    expect(canTransitionVendor('draft', 'pending_kyc')).toBe(true);
    expect(canTransitionVendor('under_review', 'approved')).toBe(true);
    expect(canTransitionVendor('under_review', 'pending_kyc')).toBe(true);
    expect(canTransitionVendor('approved', 'suspended')).toBe(true);
    expect(canTransitionVendor('blocked', 'archived')).toBe(true);
    // No jump from draft to approved, and a blocked vendor never comes back.
    expect(canTransitionVendor('draft', 'approved')).toBe(false);
    expect(canTransitionVendor('blocked', 'approved')).toBe(false);
    expect(canTransitionVendor('archived', 'draft')).toBe(false);
  });

  it('follows the purchase request flow', () => {
    expect(canTransitionPr('submitted', 'dept_approved')).toBe(true);
    expect(canTransitionPr('dept_approved', 'sourcing')).toBe(true);
    expect(canTransitionPr('commitment_pending', 'approved')).toBe(true);
    expect(canTransitionPr('commitment_pending', 'sourcing')).toBe(true);
    // The commitment route runs after the RFQ, never before it (AD10).
    expect(canTransitionPr('submitted', 'commitment_pending')).toBe(false);
    expect(canTransitionPr('draft', 'po_issued')).toBe(false);
    expect(canTransitionPr('rejected', 'submitted')).toBe(false);
  });

  it('follows the purchase order flow', () => {
    expect(canTransitionPo('draft', 'issued')).toBe(true);
    expect(canTransitionPo('issued', 'amendment_pending')).toBe(true);
    expect(canTransitionPo('amendment_pending', 'issued')).toBe(true);
    expect(canTransitionPo('partially_received', 'short_closed')).toBe(true);
    expect(canTransitionPo('draft', 'fully_received')).toBe(false);
    expect(canTransitionPo('closed', 'issued')).toBe(false);
  });

  it('lets a receipt reversal move a purchase order back, and nothing else', () => {
    expect(canTransitionPo('fully_received', 'partially_received')).toBe(true);
    expect(canTransitionPo('fully_received', 'issued')).toBe(true);
    expect(canTransitionPo('partially_received', 'issued')).toBe(true);
    expect(canTransitionPo('fully_received', 'closed')).toBe(true);
    expect(canTransitionPo('fully_received', 'cancelled')).toBe(false);
    // F1-Q39: an order that has everything can still be amended up, so more can be received.
    expect(canTransitionPo('fully_received', 'amendment_pending')).toBe(true);
    expect(canTransitionPo('closed', 'fully_received')).toBe(false);
    expect(canTransitionPo('short_closed', 'partially_received')).toBe(false);
  });

  it('follows the bill flow, and a bill reaches approval only through matching', () => {
    expect(canTransitionBill('draft', 'matching')).toBe(true);
    expect(canTransitionBill('matching', 'pending_approval')).toBe(true);
    expect(canTransitionBill('matching', 'variance')).toBe(true);
    expect(canTransitionBill('exception_pending', 'pending_approval')).toBe(true);
    expect(canTransitionBill('approved', 'voided')).toBe(true);
    expect(canTransitionBill('draft', 'approved')).toBe(false);
    expect(canTransitionBill('variance', 'pending_approval')).toBe(false);
    expect(canTransitionBill('paid', 'voided')).toBe(false);
  });

  // Every move the bills service and the approval subjects write (vendor-bills.service.ts, vendor-bill.subject.ts).
  it.each([
    ['a non-PO bill goes to approval straight from draft', 'draft', 'pending_approval'],
    ['a first match outside tolerance goes from draft to variance', 'draft', 'variance'],
    [
      'a rejected or returned match exception puts the bill back in variance',
      'exception_pending',
      'variance',
    ],
    ['a match run within tolerance after a variance goes back to matching', 'variance', 'matching'],
    ['Finance is asked to accept a variance', 'variance', 'exception_pending'],
    ['an approver returns a bill to draft', 'pending_approval', 'draft'],
  ] as const)('allows the move the service writes: %s', (_label, from, to) => {
    expect(canTransitionBill(from, to)).toBe(true);
  });

  it.each([
    ['variance', 'pending_approval'],
    ['variance', 'approved'],
    ['exception_pending', 'approved'],
    ['exception_pending', 'draft'],
    ['draft', 'exception_pending'],
    ['rejected', 'draft'],
  ] as const)(
    'still refuses %s to %s: a bill in variance never skips the exception',
    (from, to) => {
      expect(canTransitionBill(from, to)).toBe(false);
    },
  );

  it('follows the payment request flow', () => {
    expect(canTransitionPaymentRequest('draft', 'pending_approval')).toBe(true);
    expect(canTransitionPaymentRequest('pending_approval', 'approved')).toBe(true);
    expect(canTransitionPaymentRequest('pending_approval', 'rejected')).toBe(true);
    expect(canTransitionPaymentRequest('approved', 'cancelled')).toBe(true);
    expect(canTransitionPaymentRequest('draft', 'approved')).toBe(false);
    expect(canTransitionPaymentRequest('rejected', 'approved')).toBe(false);
  });
});

describe('P4 document types', () => {
  it('lists the eight approval document types', () => {
    expect([...P4_DOCUMENT_TYPES]).toEqual([
      'purchase_request',
      'pr_commitment',
      'po_amendment',
      'po_vendor_change',
      'match_exception',
      'vendor_bill',
      'payment_request',
      'emergency_review',
    ]);
  });
});

describe('vendor DTOs', () => {
  const company = {
    legalName: 'Himal Supplies Pvt Ltd',
    kind: 'company',
    pan: '123456789',
    vatRegistered: true,
    country: 'NP',
  };

  it('parses a valid vendor and rejects invalid ones', () => {
    expect(CreateVendorBodySchema.safeParse(company).success).toBe(true);
    expect(CreateVendorBodySchema.safeParse({ ...company, pan: '12345' }).success).toBe(false);
    expect(CreateVendorBodySchema.safeParse({ ...company, pan: undefined }).success).toBe(false);
    expect(CreateVendorBodySchema.safeParse({ ...company, kind: 'ngo' }).success).toBe(false);
    expect(CreateVendorBodySchema.safeParse({ ...company, legalName: '  ' }).success).toBe(false);
    expect(CreateVendorBodySchema.safeParse({ ...company, status: 'approved' }).success).toBe(
      false,
    );
  });

  it('lets a foreign vendor omit the PAN', () => {
    const foreign = {
      legalName: 'Acme GmbH',
      kind: 'foreign',
      vatRegistered: false,
      country: 'DE',
    };
    expect(CreateVendorBodySchema.safeParse(foreign).success).toBe(true);
    expect(CreateVendorBodySchema.safeParse({ ...foreign, country: 'Germany' }).success).toBe(
      false,
    );
  });

  it('accepts a bank proposal and refuses an unknown key', () => {
    const body = {
      bankName: 'Nabil Bank',
      accountName: 'Himal Supplies',
      accountNumber: '0123456789',
    };
    expect(ProposeBankAccountBodySchema.safeParse(body).success).toBe(true);
    expect(ProposeBankAccountBodySchema.safeParse({ ...body, accountNumber: '12' }).success).toBe(
      false,
    );
    expect(ProposeBankAccountBodySchema.safeParse({ ...body, status: 'active' }).success).toBe(
      false,
    );
  });

  it('shows a bank account as last four digits only', () => {
    const dto = {
      id: id(1),
      vendorPartyId: id(2),
      bankName: 'Nabil Bank',
      branch: null,
      accountName: 'Himal Supplies',
      accountLast4: '6789',
      status: 'active',
      proposedVia: 'staff',
      verifiedAt: '2026-11-09T10:00:00Z',
    };
    expect(VendorBankAccountDtoSchema.safeParse(dto).success).toBe(true);
    expect(
      VendorBankAccountDtoSchema.safeParse({ ...dto, accountNumber: '0123456789' }).success,
    ).toBe(false);
    expect(
      VendorBankAccountDtoSchema.safeParse({ ...dto, accountLast4: '0123456789' }).success,
    ).toBe(false);
    expect([...BANK_ACCOUNT_STATUSES]).toEqual(['proposed', 'active', 'retired', 'rejected']);
  });
});

describe('procurement DTOs', () => {
  const line = { description: 'Laptop', uom: 'pcs', quantity: '2', estimatedUnitPrice: '90000.00' };
  const pr = {
    requestType: 'goods',
    departmentId: id(3),
    costCenterId: id(4),
    justification: 'Replace two broken laptops',
    requiredBy: '2026-12-01',
    budgetCode: 'IT-2083',
    currency: 'NPR',
    isEmergency: false,
    lines: [line],
  };

  it('parses a valid purchase request and rejects invalid ones', () => {
    expect(CreatePurchaseRequestBodySchema.safeParse(pr).success).toBe(true);
    expect(CreatePurchaseRequestBodySchema.safeParse({ ...pr, lines: [] }).success).toBe(false);
    expect(
      CreatePurchaseRequestBodySchema.safeParse({ ...pr, lines: [{ ...line, quantity: '0' }] })
        .success,
    ).toBe(false);
    expect(CreatePurchaseRequestBodySchema.safeParse({ ...pr, requiredBy: '1 Dec' }).success).toBe(
      false,
    );
    expect(CreatePurchaseRequestBodySchema.safeParse({ ...pr, status: 'approved' }).success).toBe(
      false,
    );
  });

  it('requires a reason for an emergency purchase request', () => {
    expect(CreatePurchaseRequestBodySchema.safeParse({ ...pr, isEmergency: true }).success).toBe(
      false,
    );
    expect(
      CreatePurchaseRequestBodySchema.safeParse({
        ...pr,
        isEmergency: true,
        emergencyReason: 'Server room is down',
      }).success,
    ).toBe(true);
  });

  it('parses an RFQ body: distinct vendors, a zoned deadline, no server fields', () => {
    const rfq = {
      purchaseRequestId: id(9),
      deadline: '2026-11-20T10:00:00+05:45',
      vendorIds: [id(10), id(11)],
    };
    expect(CreateRfqBodySchema.safeParse(rfq).success).toBe(true);
    expect(CreateRfqBodySchema.safeParse({ ...rfq, vendorIds: [] }).success).toBe(false);
    expect(CreateRfqBodySchema.safeParse({ ...rfq, vendorIds: [id(10), id(10)] }).success).toBe(
      false,
    );
    expect(
      CreateRfqBodySchema.safeParse({
        ...rfq,
        vendorIds: Array.from({ length: 51 }, (_, i) => id(i)),
      }).success,
    ).toBe(false);
    expect(CreateRfqBodySchema.safeParse({ ...rfq, deadline: '2026-11-20' }).success).toBe(false);
    expect(CreateRfqBodySchema.safeParse({ ...rfq, status: 'open' }).success).toBe(false);
  });

  describe('quotation bodies', () => {
    const qline = { prLineId: id(12), quantity: '2.5', unitPrice: '1500.50', taxCodeId: id(13) };
    const fields = { currency: 'NPR', lines: [qline] };
    const record = { vendorId: id(14), documentId: id(15), ...fields };
    const convert = { submissionId: id(16), ...fields };

    it('parses a recorded quotation and a converted submission', () => {
      expect(RecordQuotationBodySchema.safeParse(record).success).toBe(true);
      expect(ConvertSubmissionBodySchema.safeParse(convert).success).toBe(true);
      expect(
        RecordQuotationBodySchema.safeParse({
          ...record,
          vendorRef: 'Q-77',
          validUntil: '2026-12-31',
          deliveryDays: 14,
          warranty: '1 year',
          terms: 'Net 30',
        }).success,
      ).toBe(true);
    });

    it('keeps the two bodies apart: each takes its own source id and nothing else', () => {
      expect(RecordQuotationBodySchema.safeParse(convert).success).toBe(false);
      expect(ConvertSubmissionBodySchema.safeParse(record).success).toBe(false);
      expect(RecordQuotationBodySchema.safeParse({ ...record, total: '1.00' }).success).toBe(false);
    });

    it('holds quantity to 4 places and price to 2, as plain unsigned decimals', () => {
      const withLine = (over: Record<string, unknown>) => ({
        ...record,
        lines: [{ ...qline, ...over }],
      });
      expect(RecordQuotationBodySchema.safeParse(withLine({ quantity: '1.2345' })).success).toBe(
        true,
      );
      expect(RecordQuotationBodySchema.safeParse(withLine({ quantity: '1.23456' })).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse(withLine({ unitPrice: '1.234' })).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse(withLine({ unitPrice: '-1' })).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse(withLine({ unitPrice: 'abc' })).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse(withLine({ unitPrice: 15 })).success).toBe(false);
    });

    it('needs a currency and at least one line, and bounds the optional fields', () => {
      expect(RecordQuotationBodySchema.safeParse({ ...record, lines: [] }).success).toBe(false);
      expect(RecordQuotationBodySchema.safeParse({ ...record, currency: 'XYZ' }).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse({ ...record, deliveryDays: -1 }).success).toBe(
        false,
      );
      expect(RecordQuotationBodySchema.safeParse({ ...record, validUntil: 'soon' }).success).toBe(
        false,
      );
    });
  });

  it('parses quotation scores between 0 and 100, one to twenty of them', () => {
    const score = { criterion: 'price', score: 80 };
    expect(ScoreQuotationBodySchema.safeParse({ scores: [score] }).success).toBe(true);
    expect(
      ScoreQuotationBodySchema.safeParse({ scores: [{ ...score, score: 0, comment: 'ok' }] })
        .success,
    ).toBe(true);
    expect(ScoreQuotationBodySchema.safeParse({ scores: [] }).success).toBe(false);
    expect(ScoreQuotationBodySchema.safeParse({ scores: [{ ...score, score: 101 }] }).success).toBe(
      false,
    );
    expect(ScoreQuotationBodySchema.safeParse({ scores: [{ ...score, score: -1 }] }).success).toBe(
      false,
    );
    expect(ScoreQuotationBodySchema.safeParse({ scores: [{ score: 5 }] }).success).toBe(false);
    expect(
      ScoreQuotationBodySchema.safeParse({ scores: Array.from({ length: 21 }, () => score) })
        .success,
    ).toBe(false);
  });

  it('parses a receipt line with no over-receipt exception id at all (F1-Q39: amend the order first)', () => {
    const body = {
      purchaseOrderId: id(6),
      kind: 'goods',
      receivedAt: '2026-11-09',
      lines: [{ poLineId: id(7), quantity: '3' }],
    };
    const withLine = (extra: Record<string, unknown>) => ({
      ...body,
      lines: [{ ...body.lines[0], ...extra }],
    });
    expect(ConfirmReceiptBodySchema.safeParse(body).success).toBe(true);
    for (const exception of [null, id(8), 'x']) {
      expect(
        ConfirmReceiptBodySchema.safeParse(withLine({ overReceiptExceptionId: exception })).success,
      ).toBe(false);
    }
    expect(ConfirmReceiptBodySchema.safeParse(withLine({ status: 'confirmed' })).success).toBe(
      false,
    );
  });

  it('keeps the recommendation reason for fewer than the minimum quotes optional but bounded', () => {
    const body = { vendorQuotationId: id(5), rationale: 'Lowest total and best warranty' };
    expect(RecommendQuotationBodySchema.safeParse(body).success).toBe(true);
    expect(
      RecommendQuotationBodySchema.safeParse({ ...body, fewerThanThreeReason: 'Sole supplier' })
        .success,
    ).toBe(true);
    expect(
      RecommendQuotationBodySchema.safeParse({ ...body, fewerThanThreeReason: '' }).success,
    ).toBe(false);
    expect(
      RecommendQuotationBodySchema.safeParse({ vendorQuotationId: 'x', rationale: 'r' }).success,
    ).toBe(false);
  });
});

describe('payables DTOs', () => {
  const billLine = {
    accountId: id(6),
    quantity: '2',
    unitPrice: '1000.00',
    taxCodeId: id(7),
    poLineId: id(8),
  };
  const bill = {
    vendorPartyId: id(2),
    vendorInvoiceNo: 'INV-001',
    invoiceDate: '2026-11-01',
    currency: 'NPR',
    documentId: id(9),
    lines: [billLine],
  };

  it('parses a valid bill and rejects invalid ones', () => {
    expect(CreateVendorBillBodySchema.safeParse(bill).success).toBe(true);
    expect(CreateVendorBillBodySchema.safeParse({ ...bill, lines: [] }).success).toBe(false);
    expect(CreateVendorBillBodySchema.safeParse({ ...bill, vendorInvoiceNo: '' }).success).toBe(
      false,
    );
    // Totals are computed by the server, so a client cannot send them.
    expect(CreateVendorBillBodySchema.safeParse({ ...bill, payableTotal: '1.00' }).success).toBe(
      false,
    );
    expect(
      CreateVendorBillBodySchema.safeParse({ ...bill, lines: [{ ...billLine, unitPrice: '-1' }] })
        .success,
    ).toBe(false);
  });

  it('parses a payment request and rejects empty or non-positive allocations', () => {
    const req = {
      vendorPartyId: id(2),
      paymentType: 'settlement',
      currency: 'NPR',
      fromBankAccountId: id(10),
      allocations: [{ openItemId: id(11), amount: '500.00' }],
    };
    expect(RequestPaymentBodySchema.safeParse(req).success).toBe(true);
    expect(RequestPaymentBodySchema.safeParse({ ...req, allocations: [] }).success).toBe(false);
    expect(
      RequestPaymentBodySchema.safeParse({
        ...req,
        allocations: [{ openItemId: id(11), amount: '0' }],
      }).success,
    ).toBe(false);
    expect(RequestPaymentBodySchema.safeParse({ ...req, paymentType: 'advance' }).success).toBe(
      false,
    );
    expect(
      RequestPaymentBodySchema.safeParse({
        ...req,
        paymentType: 'advance',
        purchaseOrderId: id(12),
      }).success,
    ).toBe(true);
    expect(RequestPaymentBodySchema.safeParse({ ...req, status: 'approved' }).success).toBe(false);
  });
});

describe('vendor portal allow-list DTOs', () => {
  const po = {
    id: id(20),
    number: 'PO-2083-00001',
    version: 2,
    status: 'issued',
    issueDate: '2026-11-02',
    currency: 'NPR',
    total: '113000.00',
    paymentTermsDays: 15,
    lines: [
      {
        lineNo: 1,
        description: 'Laptop',
        uom: 'pcs',
        quantity: '2',
        unitPrice: '50000.00',
        receivedQuantity: '1',
      },
    ],
    file: null,
  };
  const bill = {
    id: id(21),
    number: 'BILL-2083-00001',
    vendorInvoiceNo: 'INV-001',
    invoiceDate: '2026-11-01',
    currency: 'NPR',
    payableTotal: '111500.00',
    tdsAmount: '1500.00',
    status: 'approved_for_payment',
    payments: [{ paidOn: '2026-11-08', amount: '111500.00', reference: 'FT1234' }],
  };

  it('parses a valid purchase order view and refuses an extra key at any depth', () => {
    expect(VendorPortalPurchaseOrderViewSchema.safeParse(po).success).toBe(true);
    expect(
      VendorPortalPurchaseOrderViewSchema.safeParse({ ...po, costCenterId: id(1) }).success,
    ).toBe(false);
    expect(
      VendorPortalPurchaseOrderViewSchema.safeParse({ ...po, approvalChain: [] }).success,
    ).toBe(false);
    const withLineLeak = { ...po, lines: [{ ...po.lines[0], budgetCode: 'IT' }] };
    expect(VendorPortalPurchaseOrderViewSchema.safeParse(withLineLeak).success).toBe(false);
  });

  it('shows no PO that the vendor must not see', () => {
    expect([...VENDOR_VISIBLE_PO_STATUSES]).not.toContain('draft');
    expect([...VENDOR_VISIBLE_PO_STATUSES]).not.toContain('amendment_pending');
    expect(VendorPortalPurchaseOrderViewSchema.safeParse({ ...po, status: 'draft' }).success).toBe(
      false,
    );
  });

  it('shows a bill with a coarse status, and refuses internal statuses and keys', () => {
    expect(VendorPortalBillViewSchema.safeParse(bill).success).toBe(true);
    for (const status of ['received', 'under_review', 'approved_for_payment', 'rejected']) {
      expect(VendorPortalBillViewSchema.safeParse({ ...bill, status }).success).toBe(true);
    }
    expect(VendorPortalBillViewSchema.safeParse({ ...bill, status: 'variance' }).success).toBe(
      false,
    );
    expect(VendorPortalBillViewSchema.safeParse({ ...bill, matchStatus: 'variance' }).success).toBe(
      false,
    );
    expect(VendorPortalBillViewSchema.safeParse({ ...bill, tdsAccountId: id(1) }).success).toBe(
      false,
    );
  });

  it('shows a bank account as last four digits only', () => {
    const view = { bankName: 'Nabil Bank', accountLast4: '6789', status: 'active' };
    expect(VendorPortalBankViewSchema.safeParse(view).success).toBe(true);
    expect(
      VendorPortalBankViewSchema.safeParse({ ...view, accountNumber: '0123456789' }).success,
    ).toBe(false);
  });

  it('has no key that names an internal field', () => {
    expect(forbiddenPortalKeys(po)).toEqual([]);
    expect(forbiddenPortalKeys(bill)).toEqual([]);
    expect(
      forbiddenPortalKeys({ lines: [{ comparisonScore: 4 }], reviewNote: 'x', cost_center: 'y' }),
    ).toEqual(['comparisonScore', 'reviewNote', 'cost_center']);
    expect(VENDOR_PORTAL_FORBIDDEN_WORDS).toContain('score');
  });
});
