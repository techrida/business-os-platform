// Contract test of the vendor portal's DTOs (P4 unit PV1, done check 13 "the allow-list contract test passes").
// Serves the NFR "a vendor sees only what we meant to show":
// - the key set of every view schema is pinned at every depth, so a schema that gains a key fails here and the
//   change has to be looked at on purpose;
// - the mappers build exactly those keys from inputs that carry internal columns, and no key names an internal
//   field (forbiddenPortalKeys);
// - the coarse bill status and the onboarding states are pinned.
import {
  forbiddenPortalKeys,
  VendorPortalBillViewSchema,
  VendorPortalOnboardingViewSchema,
  VendorPortalPurchaseOrderListItemSchema,
  VendorPortalPurchaseOrderViewSchema,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type BillSource,
  type InternalBillStatus,
  type PoSource,
  toBillView,
  toOnboardingView,
  toPurchaseOrderListItem,
  toPurchaseOrderView,
  vendorBillStatus,
} from './portal-vendor.views';

/** Every key path of a schema: objects by key, arrays as `[]`, nullable and optional unwrapped. */
function keyPaths(schema: z.ZodType, prefix = ''): string[] {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return keyPaths(schema.unwrap() as z.ZodType, prefix);
  }
  if (schema instanceof z.ZodArray) return keyPaths(schema.element as z.ZodType, `${prefix}[].`);
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...keyPaths(v, `${prefix}${k}.`),
    ]);
  }
  return [];
}

/** Every key path of a value, the same notation. */
function valuePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((v) => valuePaths(v, `${prefix}[].`)))];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...valuePaths(v, `${prefix}${k}.`),
    ]);
  }
  return [];
}

const sorted = (xs: string[]) => [...xs].sort();

const PO_LIST_KEYS = ['currency', 'id', 'issueDate', 'number', 'status', 'total', 'version'];
const PO_VIEW_KEYS = [
  'currency',
  'file',
  'file.documentId',
  'file.filename',
  'file.sha256',
  'id',
  'issueDate',
  'lines',
  'lines.[].description',
  'lines.[].lineNo',
  'lines.[].quantity',
  'lines.[].receivedQuantity',
  'lines.[].unitPrice',
  'lines.[].uom',
  'number',
  'paymentTermsDays',
  'status',
  'total',
  'version',
];
const BILL_KEYS = [
  'currency',
  'id',
  'invoiceDate',
  'number',
  'payableTotal',
  'payments',
  'payments.[].amount',
  'payments.[].paidOn',
  'payments.[].reference',
  'status',
  'tdsAmount',
  'vendorInvoiceNo',
];
const ONBOARDING_KEYS = [
  'capability',
  'detailsChanged',
  'detailsChanged.at',
  'detailsChanged.by',
  'documents',
  'documents.[].docType',
  'documents.[].state',
  'documents.[].validUntil',
  'status',
];

const PO_ID = '00000000-0000-4000-8000-0000000000a1';
const VERSION_ID = '00000000-0000-4000-8000-0000000000a2';
const LINE_ID = '00000000-0000-4000-8000-0000000000a3';
const DOC_ID = '00000000-0000-4000-8000-0000000000a4';
const SHA = 'a'.repeat(64);

/** A version snapshot as snapshotOf writes it, internal fields included (advance, FX, tax code, PR line). */
const snapshot = {
  purchaseOrder: {
    id: PO_ID,
    number: 'PO-1',
    purchaseRequestId: '00000000-0000-4000-8000-0000000000b1',
    vendorId: '00000000-0000-4000-8000-0000000000b2',
    currency: 'NPR',
    paymentTermsDays: 30,
    advancePercent: '0.00',
    fxRate: '1.000000',
    fxSource: null,
    fxDate: null,
  },
  lines: [
    {
      id: LINE_ID,
      lineNo: 1,
      prLineId: null,
      kind: 'goods',
      description: 'Laptop',
      uom: 'pcs',
      orderedQuantity: '2.0000',
      cancelledQuantity: '0.0000',
      unitPrice: '50000.00',
      taxCodeId: '00000000-0000-4000-8000-0000000000b3',
      gross: '100000.00',
      taxAmount: '13000.00',
      lineTotal: '113000.00',
    },
  ],
};

const po = (status: PoSource['status'] = 'issued'): PoSource => ({
  id: PO_ID,
  number: 'PO-1',
  status,
  version: {
    id: VERSION_ID,
    version: 2,
    total: '113000.00',
    snapshot,
    createdAt: new Date('2026-11-09T20:00:00Z'),
  },
});

const bill = (status: InternalBillStatus = 'approved'): BillSource => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'bill',
  number: 'BILL-1',
  vendorInvoiceNo: 'INV-001',
  invoiceDate: '2026-11-01',
  currency: 'NPR',
  payableTotal: '111500.00',
  tdsTotal: '1500.00',
  status,
});

describe('vendor portal DTO key sets (a new key fails here)', () => {
  it('pins the purchase order list item', () => {
    expect(sorted(keyPaths(VendorPortalPurchaseOrderListItemSchema))).toEqual(PO_LIST_KEYS);
  });
  it('pins the purchase order view', () => {
    expect(sorted(keyPaths(VendorPortalPurchaseOrderViewSchema))).toEqual(PO_VIEW_KEYS);
  });
  it('pins the bill view', () => {
    expect(sorted(keyPaths(VendorPortalBillViewSchema))).toEqual(BILL_KEYS);
  });
  it('pins the onboarding view', () => {
    expect(sorted(keyPaths(VendorPortalOnboardingViewSchema))).toEqual(ONBOARDING_KEYS);
  });
  it('names no internal field in any pinned key', () => {
    for (const keys of [PO_LIST_KEYS, PO_VIEW_KEYS, BILL_KEYS, ONBOARDING_KEYS]) {
      const asObject = Object.fromEntries(keys.map((k) => [k.split('.').pop() ?? k, 1]));
      expect(forbiddenPortalKeys(asObject)).toEqual([]);
    }
    expect(forbiddenPortalKeys({ costCentre: 1, lines: [{ reviewNote: 'x' }] })).toEqual([
      'costCentre',
      'reviewNote',
    ]);
  });
  it('refuses a view with an extra key', () => {
    const view = toPurchaseOrderListItem(po(), new Map());
    expect(() =>
      VendorPortalPurchaseOrderListItemSchema.parse({ ...view, approvedBand: 'base' }),
    ).toThrow();
  });
});

describe('vendor portal mappers', () => {
  it('builds the purchase order view with exactly the pinned keys from a snapshot full of internal fields', () => {
    const view = toPurchaseOrderView(po(), new Map([[LINE_ID, '1.0000']]), {
      documentId: DOC_ID,
      filename: 'PO-1-v2.pdf',
      sha256: SHA,
    });
    expect(view).toBeDefined();
    expect(sorted(valuePaths(view))).toEqual(PO_VIEW_KEYS);
    expect(forbiddenPortalKeys(view)).toEqual([]);
    expect(view).toMatchObject({
      version: 2,
      status: 'issued',
      // 20:00 UTC is the next day in Kathmandu.
      issueDate: '2026-11-10',
      paymentTermsDays: 30,
      lines: [{ quantity: '2.0000', unitPrice: '50000.00', receivedQuantity: '1.0000' }],
    });
  });

  it('builds the list item with exactly the pinned keys', () => {
    const item = toPurchaseOrderListItem(po(), new Map());
    expect(sorted(valuePaths(item))).toEqual(PO_LIST_KEYS);
    expect(forbiddenPortalKeys(item)).toEqual([]);
  });

  it('hides a draft, and shows a pending amendment as its last issued version with the receipts status', () => {
    expect(toPurchaseOrderView(po('draft'), new Map(), null)).toBeUndefined();
    expect(toPurchaseOrderListItem(po('draft'), new Map())).toBeUndefined();
    expect(toPurchaseOrderView(po('amendment_pending'), new Map(), null)?.status).toBe('issued');
    expect(
      toPurchaseOrderView(po('amendment_pending'), new Map([[LINE_ID, '1.0000']]), null)?.status,
    ).toBe('partially_received');
  });

  it('builds the bill view with exactly the pinned keys', () => {
    const view = toBillView(bill());
    // An empty payments array has no element keys to walk.
    expect(sorted(valuePaths(view))).toEqual(BILL_KEYS.filter((k) => !k.startsWith('payments.')));
    expect(forbiddenPortalKeys(view)).toEqual([]);
    expect(view?.tdsAmount).toBe('1500.00');
  });

  it('maps every internal bill status to the coarse one, and hides voided bills and credit notes', () => {
    const expected: Record<InternalBillStatus, string | null> = {
      draft: 'received',
      matching: 'under_review',
      variance: 'under_review',
      exception_pending: 'under_review',
      pending_approval: 'under_review',
      approved: 'approved_for_payment',
      partially_paid: 'approved_for_payment',
      paid: 'approved_for_payment',
      rejected: 'rejected',
      voided: null,
      discarded: null,
    };
    for (const [s, coarse] of Object.entries(expected)) {
      expect(vendorBillStatus(s as InternalBillStatus)).toBe(coarse);
    }
    expect(toBillView(bill('voided'))).toBeUndefined();
    expect(toBillView(bill('discarded'))).toBeUndefined();
    expect(toBillView({ ...bill(), kind: 'vendor_credit_note' })).toBeUndefined();
    expect(toBillView({ ...bill(), number: null })).toBeUndefined();
  });

  it('builds the onboarding view: missing, submitted, accepted, expired and rejected, with no review note', () => {
    const view = toOnboardingView(
      'pending_kyc',
      [
        { key: 'pan_certificate', status: 'provided', expiresOn: null },
        { key: 'vat_certificate', status: 'accepted', expiresOn: null },
        { key: 'tax_clearance', status: 'accepted', expiresOn: '2026-07-15' },
        { key: 'bank_proof', status: 'rejected', expiresOn: null },
      ],
      '2026-11-10',
    );
    expect(sorted(valuePaths(view))).toEqual(
      ONBOARDING_KEYS.filter((k) => !k.startsWith('detailsChanged.')),
    );
    expect(view.detailsChanged).toBeNull();
    const changed = toOnboardingView('pending_kyc', [], '2026-11-10', {
      at: '2026-11-23T04:00:00.000Z',
      by: 'Sita Founder',
    });
    expect(sorted(valuePaths(changed))).toEqual(ONBOARDING_KEYS);
    expect(forbiddenPortalKeys(changed)).toEqual([]);
    expect(forbiddenPortalKeys(view)).toEqual([]);
    expect(view.capability).toBe('onboarding_only');
    const state = Object.fromEntries(view.documents.map((d) => [d.docType, d.state]));
    expect(state).toEqual({
      pan_certificate: 'submitted',
      vat_certificate: 'accepted',
      company_registration: 'missing',
      tax_clearance: 'expired',
      bank_proof: 'rejected',
      proprietor_citizenship: 'missing',
      foreign_registration: 'missing',
    });
    expect(
      toOnboardingView('draft', undefined, '2026-11-10').documents.every(
        (d) => d.state === 'missing',
      ),
    ).toBe(true);
  });
});
