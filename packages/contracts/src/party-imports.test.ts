import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLE_PERMISSIONS } from './authz.js';
import { SalesVatRegisterQuerySchema, SalesVatRegisterSchema } from './invoicing.js';
import {
  PARTY_IMPORT_COLUMNS,
  PARTY_IMPORT_EXAMPLE,
  PARTY_IMPORT_KINDS,
  PARTY_IMPORT_MAX_BYTES,
  PARTY_IMPORT_MAX_ROWS,
  PARTY_IMPORT_REQUIRED,
  PartyImportRowSchema,
} from './party-imports.js';

describe('party import templates', () => {
  it('gives each kind an example row of the same width as its header, and required columns that exist', () => {
    for (const kind of PARTY_IMPORT_KINDS) {
      expect(PARTY_IMPORT_EXAMPLE[kind]).toHaveLength(PARTY_IMPORT_COLUMNS[kind].length);
      for (const column of PARTY_IMPORT_REQUIRED[kind]) {
        expect(PARTY_IMPORT_COLUMNS[kind] as readonly string[]).toContain(column);
      }
      expect(new Set(PARTY_IMPORT_COLUMNS[kind]).size).toBe(PARTY_IMPORT_COLUMNS[kind].length);
    }
  });

  it('keeps the limits the brief set: 2 MB and 2,000 rows', () => {
    expect(PARTY_IMPORT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(PARTY_IMPORT_MAX_ROWS).toBe(2000);
  });

  it('refuses a row with an unknown key or a line before the first record', () => {
    const row = { line: 2, name: 'A', pan: null, status: 'valid', issues: [] };
    expect(PartyImportRowSchema.safeParse(row).success).toBe(true);
    expect(PartyImportRowSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    expect(PartyImportRowSchema.safeParse({ ...row, line: 1 }).success).toBe(false);
  });
});

describe('sales VAT register contract and grant', () => {
  it('is held by Finance and Accountant (and the Founder, who holds everything), not by Sales or Management', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.finance['vat.sales.read']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.accountant['vat.sales.read']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.founder['vat.sales.read']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.sales['vat.sales.read']).toBeUndefined();
    expect(DEFAULT_ROLE_PERMISSIONS.management['vat.sales.read']).toBeUndefined();
  });

  it('is separate from the purchase register grant, in both directions', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['payables.vat_register.read']).toBeUndefined();
    expect(DEFAULT_ROLE_PERMISSIONS.accountant['payables.vat_register.read']).toBe('all');
  });

  it('takes a valid period only, and keeps amounts as signed two-decimal text per currency', () => {
    expect(
      SalesVatRegisterQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-30' }).success,
    ).toBe(true);
    expect(
      SalesVatRegisterQuerySchema.safeParse({ from: '2026-11-30', to: '2026-11-01' }).success,
    ).toBe(false);
    expect(
      SalesVatRegisterQuerySchema.safeParse({ from: '2026-02-30', to: '2026-11-01' }).success,
    ).toBe(false);
    const nprTotal = {
      documents: 0,
      taxableAmount: '0.00',
      vatAmount: '0.00',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      totalAmount: '0.00',
    };
    const empty = { from: '2026-11-01', to: '2026-11-30', rows: [], totals: [], nprTotal };
    expect(SalesVatRegisterSchema.safeParse(empty).success).toBe(true);
    // Two 16-digit rows add past 16 digits: the totals have their own, wider limit (FU11).
    const big = '12000000000000000.00';
    expect(
      SalesVatRegisterSchema.safeParse({
        ...empty,
        nprTotal: { ...nprTotal, documents: 2, totalAmount: big },
      }).success,
    ).toBe(true);
    const total = {
      currency: 'NPR',
      documents: 1,
      taxableAmount: '-1.00',
      vatAmount: '-0.13',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      totalAmount: '-1.13',
    };
    expect(SalesVatRegisterSchema.safeParse({ ...empty, totals: [total] }).success).toBe(true);
    expect(
      SalesVatRegisterSchema.safeParse({ ...empty, totals: [{ ...total, vatAmount: '0.123' }] })
        .success,
    ).toBe(false);
    expect(
      SalesVatRegisterSchema.safeParse({ ...empty, totals: [{ ...total, currency: 'EUR' }] })
        .success,
    ).toBe(false);
    // The NPR filing total is required, and keeps two decimals.
    expect(SalesVatRegisterSchema.safeParse({ ...empty, nprTotal: undefined }).success).toBe(false);
    expect(
      SalesVatRegisterSchema.safeParse({ ...empty, nprTotal: { ...nprTotal, vatAmount: '0.123' } })
        .success,
    ).toBe(false);
  });
});
