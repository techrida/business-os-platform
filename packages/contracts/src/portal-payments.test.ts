// The portal's payment list item (P3 U13 part 3): a strict whitelist of the eight fields the portal shows a customer.
// It serves the NFR "a customer sees only what we meant to show": the staff PaymentDto and PaymentListItem carry the
// submitter, verifier, NPR value, version and customer name, and any of them riding along must fail the parse.
import { describe, expect, it } from 'vitest';

import { PortalPaymentListItemSchema } from './receivables.js';

const item = {
  id: '7c0e1d3a-5b1f-4c52-9a67-0a1b2c3d4e5f',
  status: 'submitted',
  number: null,
  method: 'bank_transfer',
  currency: 'NPR',
  amount: '600.00',
  receivedOn: '2026-11-08',
  bankReference: null,
};

describe('PortalPaymentListItemSchema', () => {
  it('parses a submitted payment and a verified one with its receipt number', () => {
    expect(PortalPaymentListItemSchema.safeParse(item).success).toBe(true);
    expect(
      PortalPaymentListItemSchema.safeParse({
        ...item,
        status: 'verified',
        number: 'RCPT-2083/84-00001',
        bankReference: 'TXN-1',
      }).success,
    ).toBe(true);
  });

  it('has exactly the eight whitelisted fields', () => {
    expect(Object.keys(PortalPaymentListItemSchema.shape).sort()).toEqual([
      'amount',
      'bankReference',
      'currency',
      'id',
      'method',
      'number',
      'receivedOn',
      'status',
    ]);
  });

  it.each([
    ['customerId', 'a3b8d1b6-0b3b-4b1a-8c1d-111111111111'],
    ['customerName', 'Himal Traders'],
    ['unallocatedAmount', '0.00'],
    ['tdsWithheld', '0.00'],
    ['submittedBy', 'a3b8d1b6-0b3b-4b1a-8c1d-222222222222'],
    ['verifiedBy', null],
    ['rejectionReason', null],
    ['npr', null],
    ['version', 1],
    ['proofDocumentIds', []],
  ])('rejects the extra field %s', (field, value) => {
    expect(PortalPaymentListItemSchema.safeParse({ ...item, [field]: value }).success).toBe(false);
  });

  it.each([
    ['an unknown status', { status: 'paid' }],
    ['an unknown method', { method: 'barter' }],
    ['an empty receipt number', { number: '' }],
    ['a malformed date', { receivedOn: '08-11-2026' }],
    ['a three-decimal amount', { amount: '1.001' }],
    ['a missing bank reference key', { bankReference: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(PortalPaymentListItemSchema.safeParse({ ...item, ...patch }).success).toBe(false);
  });
});
