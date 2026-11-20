// The Settings rules for tax code periods (F1-Q49), and the proof that they keep issued documents as they were:
// a change applied to the rows is read back through the same picker pricing uses (resolveTaxCode on the issue day),
// and the period row an issued document names keeps its rate (the by-id readers of bills, sourcing and orders).
import { resolveTaxCode, type TaxCode } from '@bos/money-rules';
import { describe, expect, it } from 'vitest';

import {
  planTaxCodeChange,
  planTaxCodeRetire,
  STALE_TAX_CODE_MESSAGE,
  summariseTaxCodes,
  type TaxCodePeriodRow,
} from './tax-code-periods';

const TODAY = '2026-11-20';

const row = (over: Partial<TaxCodePeriodRow> & Pick<TaxCodePeriodRow, 'id'>): TaxCodePeriodRow => ({
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat',
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2025-07-17',
  effectiveTo: null,
  version: 1,
  ...over,
});

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The rows after the plan is carried out the way the service does: close the last period, add the new one. */
function apply(
  rows: readonly TaxCodePeriodRow[],
  close: { id: string; effectiveTo: string },
  added?: Partial<TaxCodePeriodRow>,
): TaxCodePeriodRow[] {
  const closed = rows.map((r) =>
    r.id === close.id ? { ...r, effectiveTo: close.effectiveTo, version: r.version + 1 } : r,
  );
  if (added === undefined) return closed;
  const last = rows.find((r) => r.id === close.id)!;
  return [
    ...closed,
    {
      ...last,
      id: ID(99),
      effectiveFrom: close.effectiveTo,
      effectiveTo: null,
      version: 1,
      ...added,
    },
  ];
}

/** The periods as pricing reads them (loadTaxCodePeriods -> priceQuotation -> resolveTaxCode). */
const asPricing = (rows: readonly TaxCodePeriodRow[]): TaxCode[] =>
  rows.map((r) => ({
    code: r.code,
    kind: r.kind,
    rateBp: r.rateBp,
    creditable: r.creditable,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));

function expectRefusal(
  result: ReturnType<typeof planTaxCodeChange>,
  status: number,
  text: string,
): void {
  expect(result).toMatchObject({ ok: false, status });
  expect(result.ok ? '' : result.message).toContain(text);
}

describe('planTaxCodeChange', () => {
  const rows = [row({ id: ID(1) })];

  it('closes the last period on the change day and leaves its rate alone', () => {
    const plan = planTaxCodeChange(rows, {
      effectiveFrom: '2026-12-01',
      expectedPeriodId: ID(1),
      expectedVersion: 1,
      today: TODAY,
    });
    expect(plan).toEqual({
      ok: true,
      close: { id: ID(1), version: 1, effectiveTo: '2026-12-01' },
    });
  });

  it('prices a document issued before the change day at the old rate and one on or after it at the new', () => {
    const plan = planTaxCodeChange(rows, {
      effectiveFrom: '2026-12-01',
      expectedPeriodId: ID(1),
      expectedVersion: 1,
      today: TODAY,
    });
    if (!plan.ok) throw new Error(plan.message);
    const after = apply(rows, plan.close, { rateBp: 1500, name: 'VAT 15%' });
    const periods = asPricing(after);
    // resolveTaxCode also throws when two periods overlap, so this proves the closed period ends where the new starts.
    expect(resolveTaxCode(periods, 'VAT13', TODAY).rateBp).toBe(1300);
    expect(resolveTaxCode(periods, 'VAT13', '2026-11-30').rateBp).toBe(1300);
    expect(resolveTaxCode(periods, 'VAT13', '2026-12-01').rateBp).toBe(1500);
    // A bill, purchase order or sourcing line names the period row by id and reads its rate by id: unchanged.
    expect(after.find((r) => r.id === ID(1))?.rateBp).toBe(1300);
  });

  it('allows a change from today, never from an earlier day', () => {
    expect(
      planTaxCodeChange(rows, {
        effectiveFrom: TODAY,
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }).ok,
    ).toBe(true);
    expectRefusal(
      planTaxCodeChange(rows, {
        effectiveFrom: '2026-11-19',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
      400,
      'before today',
    );
  });

  it('must start after the last period started, so a scheduled change is never overlapped', () => {
    const scheduled = [
      row({ id: ID(1), effectiveTo: '2027-01-01', version: 2 }),
      row({ id: ID(2), rateBp: 1500, effectiveFrom: '2027-01-01' }),
    ];
    expectRefusal(
      planTaxCodeChange(scheduled, {
        effectiveFrom: '2026-12-01',
        expectedPeriodId: ID(2),
        expectedVersion: 1,
        today: TODAY,
      }),
      400,
      '2027-01-01',
    );
    expect(
      planTaxCodeChange(scheduled, {
        effectiveFrom: '2027-04-01',
        expectedPeriodId: ID(2),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: true, close: { id: ID(2) } });
  });

  it('refuses a stale version, an unknown code and a retired code', () => {
    expect(
      planTaxCodeChange(rows, {
        effectiveFrom: '2026-12-01',
        expectedPeriodId: ID(1),
        expectedVersion: 7,
        today: TODAY,
      }),
    ).toEqual({ ok: false, status: 409, message: STALE_TAX_CODE_MESSAGE });
    expect(
      planTaxCodeChange([], {
        effectiveFrom: '2026-12-01',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expectRefusal(
      planTaxCodeChange([row({ id: ID(1), effectiveTo: '2026-12-31' })], {
        effectiveFrom: '2027-01-05',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
      409,
      'retired',
    );
  });
});

describe('a dialog opened on an earlier period', () => {
  // Final review P2: every new period starts at version 1, so the version alone cannot tell the period a dialog was
  // opened on from the one scheduled after it. Finance schedules 15% from December (a new v1 period); a dialog opened
  // earlier on the 13% period (also v1) must not then add a January change carrying 13%, nor retire the code.
  const scheduled = [
    row({ id: ID(1), effectiveTo: '2026-12-01', version: 2 }),
    row({ id: ID(2), rateBp: 1500, effectiveFrom: '2026-12-01' }),
  ];

  it('refuses a change or a retirement that names a period other than the latest, at the same version', () => {
    expect(
      planTaxCodeChange(scheduled, {
        effectiveFrom: '2027-01-01',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toEqual({ ok: false, status: 409, message: STALE_TAX_CODE_MESSAGE });
    expect(
      planTaxCodeRetire(scheduled, {
        effectiveTo: '2027-01-01',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toEqual({ ok: false, status: 409, message: STALE_TAX_CODE_MESSAGE });
  });

  it('accepts the same change from a dialog opened on the latest period', () => {
    expect(
      planTaxCodeChange(scheduled, {
        effectiveFrom: '2027-01-01',
        expectedPeriodId: ID(2),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: true, close: { id: ID(2), version: 1, effectiveTo: '2027-01-01' } });
  });
});

describe('planTaxCodeRetire', () => {
  const rows = [row({ id: ID(1) })];

  it('closes the last period: documents issued before keep the code, none are priced with it after', () => {
    const plan = planTaxCodeRetire(rows, {
      effectiveTo: '2026-12-01',
      expectedPeriodId: ID(1),
      expectedVersion: 1,
      today: TODAY,
    });
    if (!plan.ok) throw new Error(plan.message);
    const periods = asPricing(apply(rows, plan.close));
    expect(resolveTaxCode(periods, 'VAT13', '2026-11-30').rateBp).toBe(1300);
    expect(() => resolveTaxCode(periods, 'VAT13', '2026-12-01')).toThrow(/no version in force/);
  });

  it('refuses a day before today, a day not after the current start, and a second retirement', () => {
    expect(
      planTaxCodeRetire(rows, {
        effectiveTo: '2026-11-01',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      planTaxCodeRetire([row({ id: ID(1), effectiveFrom: TODAY })], {
        effectiveTo: TODAY,
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      planTaxCodeRetire([row({ id: ID(1), effectiveTo: '2026-12-01' })], {
        effectiveTo: '2026-12-05',
        expectedPeriodId: ID(1),
        expectedVersion: 1,
        today: TODAY,
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});

describe('summariseTaxCodes', () => {
  it('groups periods by code, oldest first, with the period in force today and the scheduled one', () => {
    const list = summariseTaxCodes(
      [
        row({ id: ID(2), rateBp: 1500, name: 'VAT 15%', effectiveFrom: '2027-01-01' }),
        row({ id: ID(1), effectiveTo: '2027-01-01', version: 2 }),
        row({
          id: ID(3),
          code: 'EXEMPT',
          name: 'Exempt',
          kind: 'exempt',
          rateBp: 0,
          creditable: false,
          effectiveTo: '2026-10-01',
        }),
      ],
      TODAY,
    );
    expect(list.map((c) => c.code)).toEqual(['EXEMPT', 'VAT13']);
    const vat = list[1]!;
    expect(vat.periods.map((p) => p.rate)).toEqual(['13', '15']);
    expect(vat.current?.id).toBe(ID(1));
    expect(vat.next?.id).toBe(ID(2));
    expect(vat.latest.id).toBe(ID(2));
    expect(vat.endsOn).toBeNull();
    const exempt = list[0]!;
    expect(exempt.current).toBeNull();
    expect(exempt.endsOn).toBe('2026-10-01');
  });
});
