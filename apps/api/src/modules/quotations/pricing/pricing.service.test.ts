// Unit test of PricingService.priceVersion with the real MoneyService. The database is a fake transaction whose
// queries answer by table (tax_codes, fx_rates), like money.service.test.ts; the Postgres cases (the SQL
// filters and the CHECKs on insert) belong to the quotations integration test.
import { fxRates, taxCodes } from '@bos/db';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { MoneyService } from '../../../platform/settings/money.service';
import type { SettingsService } from '../../../platform/settings/settings.service';
import { PricingService } from './pricing.service';
import type { PricingInput } from './pricing.types';
import type { TaxCodeRow } from './tax-codes.resolver';

const SCOPE = { tenantId: 'tenant-1', organizationId: 'entity-1' };
const always = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const VAT_OLD: TaxCodeRow = {
  ...always,
  id: 'tc-vat-old',
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat',
  rateBp: 1300,
  effectiveTo: '2026-12-01',
};
const VAT_NEW: TaxCodeRow = {
  ...VAT_OLD,
  id: 'tc-vat-new',
  name: 'VAT 15%',
  rateBp: 1500,
  effectiveFrom: '2026-12-01',
  effectiveTo: null,
};

interface RateRow {
  rate: string;
  source: string | null;
  rateDate: string;
}

/** A transaction whose selects answer by table: every query of a table returns that table's rows. */
function fakeTx(tables: { taxCodes: TaxCodeRow[]; fxRates?: RateRow[] }) {
  const queried: string[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const name =
          table === taxCodes ? 'tax_codes' : table === fxRates ? 'fx_rates' : 'unexpected';
        queried.push(name);
        const rows = name === 'tax_codes' ? tables.taxCodes : (tables.fxRates ?? []);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => rows,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
    }),
  };
  return { tx: tx as unknown as DbTransaction, queried };
}

function pricing(maxAgeDays = 7) {
  const asked: string[] = [];
  const settings = {
    get: (_scope: unknown, key: string) => {
      asked.push(key);
      return Promise.resolve(maxAgeDays);
    },
  } as unknown as SettingsService;
  return { service: new PricingService(new MoneyService({} as Db, settings)), asked };
}

const input = (extra: Partial<PricingInput> = {}): PricingInput => ({
  currency: 'NPR',
  issueDate: '2026-11-09',
  lines: [
    {
      lineNo: 1,
      description: 'Audit',
      uom: 'job',
      quantity: '1',
      unitPrice: '100.00',
      taxCodeId: VAT_OLD.id,
    },
  ],
  discount: null,
  ...extra,
});

describe('PricingService.priceVersion', () => {
  it('prices NPR at rate 1 with no FX source and never reads fx_rates', async () => {
    const { tx, queried } = fakeTx({ taxCodes: [VAT_OLD, VAT_NEW] });
    const pv = await pricing().service.priceVersion(tx, SCOPE, input());
    expect(pv.columns).toMatchObject({
      total: '113.00',
      amountNpr: '113.00',
      fxRate: '1.000000',
      fxSource: null,
      fxDate: null,
    });
    expect(queried).not.toContain('fx_rates');
  });

  it('snapshots USD at the latest rate: rate, source and date frozen, NPR by the C-2 rule', async () => {
    const { tx } = fakeTx({
      taxCodes: [VAT_OLD, VAT_NEW],
      fxRates: [{ rate: '133.500000', source: 'manual', rateDate: '2026-11-05' }],
    });
    const pv = await pricing().service.priceVersion(tx, SCOPE, input({ currency: 'USD' }));
    // 113.00 USD x 133.5 = 15085.50 NPR; VAT 13.00 x 133.5 = 1735.50; taxable the difference.
    expect(pv.columns).toMatchObject({
      total: '113.00',
      taxAmount: '13.00',
      fxRate: '133.500000',
      fxSource: 'manual',
      fxDate: '2026-11-05',
      amountNpr: '15085.50',
      nprTaxableAmount: '13350.00',
    });
    expect(pv.facts).toMatchObject({ amountNpr: '15085.50', currency: 'USD' });
  });

  it('refuses a stale USD rate with 409 fx_rate_stale (8 days before the issue date)', async () => {
    const { tx } = fakeTx({
      taxCodes: [VAT_OLD, VAT_NEW],
      fxRates: [{ rate: '133.500000', source: 'manual', rateDate: '2026-11-01' }],
    });
    const attempt = pricing().service.priceVersion(tx, SCOPE, input({ currency: 'USD' }));
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({ response: { code: 'fx_rate_stale' } });
  });

  it('prices INR on the standing 1.6 peg row without an age check', async () => {
    const { tx } = fakeTx({
      taxCodes: [VAT_OLD, VAT_NEW],
      fxRates: [{ rate: '1.600000', source: 'NRB peg', rateDate: '2020-01-01' }],
    });
    const { service, asked } = pricing();
    const pv = await service.priceVersion(tx, SCOPE, input({ currency: 'INR' }));
    expect(pv.columns).toMatchObject({
      fxRate: '1.600000',
      fxSource: 'NRB peg',
      fxDate: '2020-01-01',
      amountNpr: '180.80',
      nprTaxableAmount: '160.00',
    });
    expect(asked).toEqual([]);
  });

  it.each([
    ['2026-11-30', 'tc-vat-old', '13.0000', '113.00'],
    ['2026-12-01', 'tc-vat-new', '15.0000', '115.00'],
  ])(
    'on %s resolves the period %s by issue date (boundary day included)',
    async (issueDate, id, rate, total) => {
      const { tx } = fakeTx({ taxCodes: [VAT_OLD, VAT_NEW] });
      const pv = await pricing().service.priceVersion(tx, SCOPE, input({ issueDate }));
      expect(pv.lines[0]!.taxCodeId).toBe(id);
      expect(pv.taxSummary[0]).toMatchObject({ taxCodeId: id, rate });
      expect(pv.columns.total).toBe(total);
    },
  );

  it('answers 400 bad_request for a tax code id this tenant does not have', async () => {
    const { tx } = fakeTx({ taxCodes: [VAT_OLD] });
    const lines = [{ ...input().lines[0]!, taxCodeId: 'other-tenant-code' }];
    const attempt = pricing().service.priceVersion(tx, SCOPE, input({ lines }));
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({ response: { code: 'bad_request' } });
  });

  it('answers 400 bad_request, not 500, when money-rules refuses the input', async () => {
    const { tx } = fakeTx({ taxCodes: [VAT_OLD] });
    const attempt = pricing().service.priceVersion(
      tx,
      SCOPE,
      input({ discount: { mode: 'amount', value: '100.01' } }),
    );
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({ response: { code: 'bad_request' } });
  });
});
