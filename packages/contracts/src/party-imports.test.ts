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
  checkPartyImportPlace,
  formatPhonesCell,
  parsePhonesCell,
  type PartyImportKind,
} from './party-imports.js';

/** The example row of `kind` as the cells of one line, with `changes` laid over it. */
const exampleCells = (
  kind: PartyImportKind,
  changes: Record<string, string> = {},
): Record<string, string> => {
  const cells: Record<string, string> = {};
  PARTY_IMPORT_COLUMNS[kind].forEach((column, index) => {
    cells[column] = PARTY_IMPORT_EXAMPLE[kind][index]!;
  });
  return { ...cells, ...changes };
};

describe('phones cell (FX9)', () => {
  it('reads semicolon-separated numbers, takes each country from its code and makes the first primary', () => {
    expect(parsePhonesCell('+1 4155552671; +977 9812345678')).toEqual({
      ok: true,
      phones: [
        { country: 'US', e164: '+14155552671', isPrimary: true },
        { country: 'NP', e164: '+9779812345678', isPrimary: false },
      ],
    });
  });

  it('drops spaces, hyphens and brackets inside a number, and takes plain E.164', () => {
    const parsed = parsePhonesCell('+977 (1) 412-3456;+14155552671');
    expect(parsed.ok && parsed.phones.map((p) => [p.country, p.e164])).toEqual([
      ['NP', '+97714123456'],
      ['US', '+14155552671'],
    ]);
  });

  it('reads an empty cell as no numbers, and its own canonical text back to the same numbers', () => {
    expect(parsePhonesCell('')).toEqual({ ok: true, phones: [] });
    const parsed = parsePhonesCell('+1 4155552671; +977 9812345678');
    if (!parsed.ok) throw new Error(parsed.message);
    const text = formatPhonesCell(parsed.phones);
    expect(text).toBe('+14155552671;+9779812345678');
    expect(parsePhonesCell(text)).toEqual(parsed);
  });

  it("reads the template's own cell back, which carries the spreadsheet formula guard's apostrophe", () => {
    const parsed = parsePhonesCell(`'${PARTY_IMPORT_EXAMPLE.customer[8]}`);
    expect(parsed.ok && parsed.phones.map((p) => p.e164)).toEqual([
      '+9779812345678',
      '+97714123456',
    ]);
    expect(parsePhonesCell("''+9779812345678").ok).toBe(false);
  });

  it('refuses a number its country rejects, with a message', () => {
    const parsed = parsePhonesCell('+977 123');
    expect(parsed.ok).toBe(false);
    // Too short to be E.164 at all, so the E.164 rule speaks first; the message names the item.
    expect(!parsed.ok && parsed.message).toMatch(/^"\+977 123": .+/);
    const landline = parsePhonesCell('+977 012345678');
    expect(!landline.ok && landline.message).toMatch(/leading 0 of a Nepal number/);
  });

  it('refuses a number without +, other characters, an empty item, a repeat and too many numbers', () => {
    expect(parsePhonesCell('9812345678').ok).toBe(false);
    expect(parsePhonesCell('+977 98123x45678').ok).toBe(false);
    expect(parsePhonesCell('+977 9812345678;;+14155552671').ok).toBe(false);
    expect(parsePhonesCell('+977 9812345678; +9779812345678').ok).toBe(false);
    expect(parsePhonesCell('+999 1234567').ok).toBe(false);
    const six = [
      '+9779812345671',
      '+9779812345672',
      '+9779812345673',
      '+9779812345674',
      '+9779812345675',
      '+9779812345676',
    ].join(';');
    expect(parsePhonesCell(six).ok).toBe(false);
  });
});

describe('import line address, country, phones and PAN (FX9)', () => {
  it('accepts each template example row as it stands', () => {
    for (const kind of PARTY_IMPORT_KINDS) {
      expect(checkPartyImportPlace(kind, exampleCells(kind)).issues).toEqual([]);
    }
    expect(checkPartyImportPlace('customer', exampleCells('customer')).values).toMatchObject({
      address_line: 'Thapathali Marg 12',
      address_city: 'Kathmandu',
      address_country: 'NP',
      contact_country: 'NP',
      contact_phones: '+9779812345678;+97714123456',
    });
  });

  it('accepts a foreign customer with no PAN, and a foreign tax id that is not 9 digits', () => {
    const foreign = exampleCells('customer', {
      pan_vat_no: '',
      address_country: 'us',
      contact_country: 'US',
      contact_phones: '+1 4155552671',
    });
    const checked = checkPartyImportPlace('customer', foreign);
    expect(checked.issues).toEqual([]);
    expect(checked.values.address_country).toBe('US');
    expect(
      checkPartyImportPlace('customer', { ...foreign, pan_vat_no: 'EIN-12345' }).issues,
    ).toEqual([]);
  });

  it('refuses a 5-digit PAN for a customer in Nepal', () => {
    const issues = checkPartyImportPlace(
      'customer',
      exampleCells('customer', { pan_vat_no: '12345' }),
    ).issues;
    expect(issues.map((i) => i.column)).toEqual(['pan_vat_no']);
  });

  it('refuses an address line without a city, for a customer and a vendor', () => {
    for (const kind of PARTY_IMPORT_KINDS) {
      const issues = checkPartyImportPlace(kind, exampleCells(kind, { address_city: '' })).issues;
      expect(issues.map((i) => i.column)).toEqual(['address_city']);
    }
  });

  it('lets a vendor leave out the whole address, but not a customer', () => {
    const blank = { address_line: '', address_city: '' };
    expect(checkPartyImportPlace('vendor', exampleCells('vendor', blank)).issues).toEqual([]);
    expect(
      checkPartyImportPlace('customer', exampleCells('customer', blank)).issues.map(
        (i) => i.column,
      ),
    ).toEqual(['address_line', 'address_city']);
  });

  it('refuses a customer with no address country instead of assuming Nepal, and an unknown code', () => {
    for (const address_country of ['', 'ZZ', 'Nepal']) {
      const issues = checkPartyImportPlace(
        'customer',
        exampleCells('customer', { address_country }),
      ).issues;
      expect(issues.map((i) => i.column)).toEqual(['address_country']);
    }
  });

  it("needs the contact's country when a contact is given, and reports a bad phones cell on its column", () => {
    expect(
      checkPartyImportPlace(
        'customer',
        exampleCells('customer', { contact_country: '' }),
      ).issues.map((i) => i.column),
    ).toEqual(['contact_country']);
    expect(
      checkPartyImportPlace(
        'customer',
        exampleCells('customer', { contact_phones: '+977 123' }),
      ).issues.map((i) => i.column),
    ).toEqual(['contact_phones']);
    expect(
      checkPartyImportPlace('vendor', exampleCells('vendor', { contact_phone: '+1 4155552671' }))
        .values.contact_phone,
    ).toBe('+14155552671');
  });

  it("takes a vendor contact's own optional country, independent of its phones, and refuses an unknown code", () => {
    const checked = checkPartyImportPlace(
      'vendor',
      exampleCells('vendor', {
        country: 'IN',
        contact_country: 'us',
        contact_phone: '+1 4155552671; +91 9812345678',
      }),
    );
    expect(checked.issues).toEqual([]);
    expect(checked.values).toMatchObject({
      contact_country: 'US',
      contact_phone: '+14155552671;+919812345678',
    });
    // Empty means the vendor's country, which the caller fills in.
    const empty = checkPartyImportPlace('vendor', exampleCells('vendor', { contact_country: '' }));
    expect(empty.issues).toEqual([]);
    expect(empty.values.contact_country).toBe('');
    for (const contact_country of ['ZZ', 'India']) {
      expect(
        checkPartyImportPlace('vendor', exampleCells('vendor', { contact_country })).issues.map(
          (i) => i.column,
        ),
      ).toEqual(['contact_country']);
    }
  });
});

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

  it('uses the FX9 address, country and phones columns', () => {
    expect(PARTY_IMPORT_COLUMNS.customer).toEqual(
      expect.arrayContaining([
        'address_line',
        'address_city',
        'address_country',
        'contact_phones',
        'contact_country',
      ]),
    );
    expect(PARTY_IMPORT_COLUMNS.customer).not.toContain('address_line1');
    expect(PARTY_IMPORT_COLUMNS.customer).not.toContain('contact_phone');
    expect(PARTY_IMPORT_REQUIRED.customer).toEqual(
      expect.arrayContaining(['address_country', 'contact_country']),
    );
    expect(PARTY_IMPORT_COLUMNS.vendor).toEqual(
      expect.arrayContaining(['address_line', 'address_city', 'country', 'contact_country']),
    );
    expect(PARTY_IMPORT_REQUIRED.vendor).not.toContain('contact_country');
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
