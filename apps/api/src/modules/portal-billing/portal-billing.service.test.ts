// Unit tests of the portal billing rules that need no database: which invoice file counts, when its data may show,
// how a credit note settles, and that a non-customer caller is refused before any read.
import 'reflect-metadata';

import type { DocumentVersionDto } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import {
  pickInvoiceFile,
  PortalBillingService,
  toCustomerFile,
  toPortalSettlement,
  type PortalBalanceRow,
} from './portal-billing.service';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';
const SHA = 'ab'.repeat(32);

function version(over: Partial<DocumentVersionDto>): DocumentVersionDto {
  return {
    id: crypto.randomUUID(),
    documentId: DOC_A,
    version: 1,
    filename: 'INV.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    sizeBytes: 100,
    sha256: SHA,
    status: 'clean',
    scanSignature: null,
    scannedAt: null,
    uploadedBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

const row = (over: Partial<PortalBalanceRow> = {}): PortalBalanceRow => ({
  invoiceId: '33333333-3333-4333-8333-333333333333',
  kind: 'tax_invoice',
  number: 'INV-2083/84-00001',
  customerId: '44444444-4444-4444-8444-444444444444',
  currency: 'NPR',
  issueDate: '2026-11-01',
  dueDate: '2026-11-05',
  invoiceTotal: '1130.00',
  itemAmount: '1130.00',
  allocated: '0.00',
  credited: '0',
  ...over,
});

describe('pickInvoiceFile', () => {
  it('takes the newest not-rejected version of the newest document', () => {
    const older = version({ documentId: DOC_A, createdAt: '2026-11-01T00:00:00.000Z' });
    const newer = version({ documentId: DOC_B, createdAt: '2026-11-02T00:00:00.000Z' });
    expect(pickInvoiceFile([older, newer])).toBe(newer);
    const quarantinedV2 = version({
      version: 2,
      status: 'quarantined',
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    expect(pickInvoiceFile([older, quarantinedV2])).toBe(quarantinedV2);
    const rejectedV2 = version({ version: 2, status: 'rejected' });
    expect(pickInvoiceFile([older, rejectedV2])).toBe(older);
    expect(pickInvoiceFile([])).toBeUndefined();
  });
});

describe('toCustomerFile', () => {
  it('shows only a clean version with a hash', () => {
    expect(toCustomerFile(version({}))).toEqual({
      documentId: DOC_A,
      filename: 'INV.pdf',
      sha256: SHA,
    });
    expect(toCustomerFile(version({ status: 'quarantined' }))).toBeNull();
    expect(toCustomerFile(version({ sha256: null }))).toBeNull();
    expect(toCustomerFile(undefined)).toBeNull();
  });
});

describe('toPortalSettlement', () => {
  it('derives a tax invoice from its open item and keeps only the portal keys', () => {
    const s = toPortalSettlement(row({ allocated: '130.00' }), '2026-11-09');
    expect(Object.keys(s).sort()).toEqual(
      [
        'currency',
        'daysOverdue',
        'dueDate',
        'invoiceId',
        'openAmount',
        'settlement',
        'total',
      ].sort(),
    );
    expect(s).toMatchObject({ total: '1130.00', openAmount: '1000.00', daysOverdue: 4 });
  });

  it('counts an invoice without an open item as nothing allocated', () => {
    const s = toPortalSettlement(row({ itemAmount: null, allocated: null }), '2026-11-01');
    expect(s).toMatchObject({ total: '1130.00', openAmount: '1130.00', daysOverdue: 0 });
  });

  it('reads a credit note as settled: nothing is owed on it', () => {
    expect(
      toPortalSettlement(row({ kind: 'credit_note', itemAmount: null }), '2026-12-31'),
    ).toEqual({
      invoiceId: row().invoiceId,
      currency: 'NPR',
      total: '1130.00',
      openAmount: '0.00',
      dueDate: '2026-11-05',
      daysOverdue: 0,
      settlement: 'credited',
    });
  });
});

describe('PortalBillingService caller check', () => {
  it('refuses a staff principal before touching the database', async () => {
    const staff = { orgKind: 'staff', partyId: null } as unknown as Principal;
    const db = { select: vi.fn() };
    const documents = { listForOwner: vi.fn(), issueLinkForOwner: vi.fn() };
    const settings = { get: vi.fn() };
    const service = new PortalBillingService(
      { current: () => staff },
      db as never,
      documents as never,
      settings as never,
    );
    for (const call of [
      () => service.list(),
      () => service.get(DOC_A),
      () => service.settlement(DOC_A),
      () => service.documentLink(DOC_A),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(db.select).not.toHaveBeenCalled();
    expect(documents.listForOwner).not.toHaveBeenCalled();
    expect(settings.get).not.toHaveBeenCalled();
  });
});
