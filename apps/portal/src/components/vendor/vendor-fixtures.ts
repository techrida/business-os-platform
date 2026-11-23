import type {
  VendorPortalBillView,
  VendorPortalOnboardingView,
  VendorPortalPurchaseOrderListItem,
  VendorPortalPurchaseOrderView,
} from '@bos/contracts';

/**
 * Test fixtures for the vendor portal screens. Every nullable field is filled, so a test that
 * scans the rendered markup sees every field a view can show. Not imported by any page.
 */

export function sampleOnboarding(
  over: Partial<VendorPortalOnboardingView> = {},
): VendorPortalOnboardingView {
  return {
    status: 'pending_kyc',
    capability: 'onboarding_only',
    detailsChanged: null,
    documents: [
      { docType: 'pan_certificate', state: 'accepted', validUntil: null },
      { docType: 'vat_certificate', state: 'submitted', validUntil: null },
      { docType: 'tax_clearance', state: 'rejected', validUntil: '2027-07-15' },
      { docType: 'company_registration', state: 'expired', validUntil: '2026-06-30' },
      { docType: 'bank_proof', state: 'missing', validUntil: null },
    ],
    ...over,
  };
}

export function samplePoListItem(
  over: Partial<VendorPortalPurchaseOrderListItem> = {},
): VendorPortalPurchaseOrderListItem {
  return {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    number: 'PO-2082-0007',
    version: 2,
    status: 'issued',
    issueDate: '2026-11-08',
    currency: 'NPR',
    total: '1250000.50',
    ...over,
  };
}

export function samplePo(
  over: Partial<VendorPortalPurchaseOrderView> = {},
): VendorPortalPurchaseOrderView {
  return {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    number: 'PO-2082-0007',
    version: 2,
    status: 'partially_received',
    issueDate: '2026-11-08',
    currency: 'NPR',
    total: '1250000.50',
    paymentTermsDays: 30,
    lines: [
      {
        lineNo: 1,
        description: 'Cat6 patch cable, 3 m, shielded',
        uom: 'pcs',
        quantity: '120.0000',
        unitPrice: '450.00',
        receivedQuantity: '40.0000',
      },
      {
        lineNo: 2,
        description:
          'Rack-mount managed switch, 48 port gigabit with four SFP+ uplinks and redundant power supply, including five-year onsite warranty',
        uom: 'unit',
        quantity: '2.5000',
        unitPrice: '1196000.25',
        receivedQuantity: '0.0000',
      },
    ],
    file: {
      documentId: '5b6d1f0a-3c1e-4f4d-9f43-6a0e2f8d7c11',
      filename: 'PO-2082-0007-v2.pdf',
      sha256: 'a'.repeat(64),
    },
    ...over,
  };
}

export function sampleBill(over: Partial<VendorPortalBillView> = {}): VendorPortalBillView {
  return {
    id: '3c9a0b7e-6f1d-4b8a-8d52-1f0e9a7c4b22',
    number: 'BILL-2082-0031',
    vendorInvoiceNo: 'INV/2082/114',
    invoiceDate: '2026-11-02',
    currency: 'NPR',
    payableTotal: '1180000.00',
    tdsAmount: '65000.00',
    status: 'approved_for_payment',
    payments: [
      { paidOn: '2026-11-07', amount: '500000.00', reference: 'FT26311XYZ' },
      { paidOn: '2026-11-09', amount: '615000.00', reference: 'FT26313ABC' },
    ],
    ...over,
  };
}
