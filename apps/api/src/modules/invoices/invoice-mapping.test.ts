// Unit tests of the invoice detail mapper (no database): the detail carries the number and date format of the original
// print, so a screen draws the invoice the way its PDF reads.
import { InvoiceDetailSchema, type AccessScope, type Permission } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import { firstPrintFormat, invoiceCan, toInvoiceDetail } from './invoice-mapping';
import {
  ENTITY,
  issuedInvoiceRow,
  lineRow,
  printRow,
  STORED_FORMAT,
  taxRow,
  TENANT,
  USER,
} from './invoice-test-rows';

const detail = (prints: Parameters<typeof toInvoiceDetail>[0]['prints']) =>
  InvoiceDetailSchema.parse(
    toInvoiceDetail({
      invoice: issuedInvoiceRow(),
      customerName: 'Buyer Ltd.',
      lines: [lineRow()],
      taxSummary: [taxRow()],
      prints,
    }),
  );

describe('toInvoiceDetail format', () => {
  it("carries print 1's stored format, even when print 1 has no user and a later copy has one", () => {
    const copy = printRow({
      id: '14141414-1414-4414-8414-141414141414',
      printNo: 2,
      printedBy: USER,
      renderFormat: null,
    });
    const d = detail([copy, printRow()]);
    expect(d.format).toEqual(STORED_FORMAT);
    // The prints list still leaves out the print with no user.
    expect(d.prints.map((p) => p.printNo)).toEqual([2]);
  });

  it('is null when the invoice was never printed', () => {
    expect(detail([]).format).toBeNull();
  });

  it('is null when print 1 predates the stored format (render_format NULL)', () => {
    expect(detail([printRow({ renderFormat: null })]).format).toBeNull();
  });

  it('is null when what print 1 stored does not validate, rather than failing the read', () => {
    expect(detail([printRow({ renderFormat: { dateFormat: 'whenever' } })]).format).toBeNull();
  });

  it('never takes a copy’s format for the original', () => {
    expect(firstPrintFormat([printRow({ printNo: 2 })])).toBeNull();
  });
});

describe('InvoiceDetailSchema', () => {
  it('still parses an older answer with no format key', () => {
    const { format: _dropped, ...older } = detail([printRow()]);
    expect(InvoiceDetailSchema.parse(older)).not.toHaveProperty('format');
  });
});

describe('invoiceCan', () => {
  const OTHER_USER = '20202020-2020-4020-8020-202020202020';
  const WRITES: Permission[] = [
    'invoice.draft',
    'invoice.submit',
    'invoice.issue',
    'invoice.credit_note',
    'payment.record',
  ];
  const scope = { tenantId: TENANT, organizationId: ENTITY };
  const principal = (reach: AccessScope, over: Partial<Principal> = {}): Principal => ({
    userId: USER,
    zitadelUserId: `z-${USER}`,
    ...scope,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: 'unused',
    roles: [],
    departmentId: null,
    status: 'active',
    grants: new Map(WRITES.map((p): [Permission, AccessScope] => [p, reach])),
    ...over,
  });
  const drafterActions = (v: boolean) => ({ submit: v, issue: v, discard: v, notes: v });

  it('offers an own grant on the invoice the caller drafted, not on another drafter or an unset one', () => {
    const own = principal('own');
    expect(invoiceCan(own, scope, issuedInvoiceRow())).toMatchObject(drafterActions(true));
    expect(invoiceCan(own, scope, issuedInvoiceRow({ createdBy: OTHER_USER }))).toMatchObject(
      drafterActions(false),
    );
    expect(invoiceCan(own, scope, issuedInvoiceRow({ createdBy: null }))).toMatchObject(
      drafterActions(false),
    );
  });

  it('offers an all grant on every drafter, and nothing in another tenant', () => {
    const all = principal('all');
    expect(invoiceCan(all, scope, issuedInvoiceRow({ createdBy: OTHER_USER }))).toEqual({
      ...drafterActions(true),
      recordPayment: true,
    });
    const elsewhere = { ...scope, tenantId: '30303030-3030-4030-8030-303030303030' };
    expect(invoiceCan(all, elsewhere, issuedInvoiceRow())).toEqual({
      ...drafterActions(false),
      recordPayment: false,
    });
  });

  it('judges a payment on the customer: none without a customer or a payment grant', () => {
    const all = principal('all');
    const noCustomer = issuedInvoiceRow({ customerPartyId: null });
    expect(invoiceCan(all, scope, noCustomer).recordPayment).toBe(false);
    const grants = new Map(all.grants);
    grants.delete('payment.record');
    const noPayment = principal('all', { grants });
    expect(invoiceCan(noPayment, scope, issuedInvoiceRow()).recordPayment).toBe(false);
  });

  it('offers nothing to an inactive user', () => {
    const inactive = principal('all', { status: 'inactive' });
    expect(invoiceCan(inactive, scope, issuedInvoiceRow())).toEqual({
      ...drafterActions(false),
      recordPayment: false,
    });
  });
});
