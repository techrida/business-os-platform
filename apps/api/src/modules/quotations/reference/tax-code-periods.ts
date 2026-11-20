// The rules for editing a tax code's dated periods from Settings (F1-Q49), as pure functions so every case is unit
// tested without a database. Issued documents name the period row they were priced with, and pricing picks the period
// in force on the issue day (loadTaxCodePeriods), so:
// - a period is never edited: a change closes the last period on day D and adds a new one from D;
// - D is today or later in Asia/Kathmandu, so no day already priced moves to another rate;
// - retiring closes the last period; a closed (retired or retiring) code takes no further change.
import { basisPointsToPercent, type AdminTaxCode, type TaxCodePeriod } from '@bos/contracts';

import type { TaxCodeRow } from '../pricing/tax-codes.resolver';

export type TaxCodePeriodRow = Pick<
  TaxCodeRow,
  'id' | 'code' | 'name' | 'kind' | 'rateBp' | 'creditable' | 'effectiveFrom' | 'effectiveTo'
> & { version: number };

export type PeriodRefusal = { ok: false; status: 400 | 404 | 409; message: string };
export type PeriodPlan = { ok: true; close: { id: string; version: number; effectiveTo: string } };

const refuse = (status: PeriodRefusal['status'], message: string): PeriodRefusal => ({
  ok: false,
  status,
  message,
});

export const STALE_TAX_CODE_MESSAGE =
  'Someone else changed this tax code. Reload the page to see the latest version.';

const toPeriod = (row: TaxCodePeriodRow): TaxCodePeriod => ({
  id: row.id,
  name: row.name,
  rate: basisPointsToPercent(row.rateBp),
  rateBp: row.rateBp,
  creditable: row.creditable,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  version: row.version,
});

const byStart = (a: TaxCodePeriodRow, b: TaxCodePeriodRow) =>
  a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0;

/** The tenant's codes, each with its periods oldest first, the period in force on `today` and the next one. */
export function summariseTaxCodes(
  rows: readonly TaxCodePeriodRow[],
  today: string,
): AdminTaxCode[] {
  const byCode = new Map<string, TaxCodePeriodRow[]>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }
  return [...byCode.keys()].sort().map((code) => {
    const periods = [...byCode.get(code)!].sort(byStart);
    const latest = periods.at(-1)!;
    const current = periods.find(
      (p) => p.effectiveFrom <= today && (p.effectiveTo === null || p.effectiveTo > today),
    );
    const next = periods.find((p) => p.effectiveFrom > today);
    return {
      code,
      // A code keeps one kind: a change copies it, so the latest period's kind is the code's.
      kind: latest.kind,
      periods: periods.map(toPeriod),
      current: current ? toPeriod(current) : null,
      next: next ? toPeriod(next) : null,
      endsOn: latest.effectiveTo,
      latest: toPeriod(latest),
    };
  });
}

/** The last period of a code (latest start), or undefined for an unknown code. */
function latestOf(periods: readonly TaxCodePeriodRow[]): TaxCodePeriodRow | undefined {
  return [...periods].sort(byStart).at(-1);
}

/** Checks shared by a change and a retirement: the code exists, is still open-ended and was loaded fresh. */
function openLatest(
  periods: readonly TaxCodePeriodRow[],
  expectedVersion: number,
): PeriodRefusal | { ok: true; latest: TaxCodePeriodRow } {
  const latest = latestOf(periods);
  if (latest === undefined) return refuse(404, 'Tax code not found');
  if (latest.version !== expectedVersion) return refuse(409, STALE_TAX_CODE_MESSAGE);
  if (latest.effectiveTo !== null) {
    return refuse(409, `This tax code is retired from ${latest.effectiveTo} and cannot change.`);
  }
  return { ok: true, latest };
}

/** A new period from `effectiveFrom`: closes the last period that day. */
export function planTaxCodeChange(
  periods: readonly TaxCodePeriodRow[],
  input: { effectiveFrom: string; expectedVersion: number; today: string },
): PeriodPlan | PeriodRefusal {
  const open = openLatest(periods, input.expectedVersion);
  if (!open.ok) return open;
  if (input.effectiveFrom < input.today) {
    return refuse(
      400,
      'A change cannot start before today: documents already issued keep the rate they were priced with.',
    );
  }
  if (input.effectiveFrom <= open.latest.effectiveFrom) {
    return refuse(
      400,
      `A change must start after ${open.latest.effectiveFrom}, the day the current rate started.`,
    );
  }
  return {
    ok: true,
    close: {
      id: open.latest.id,
      version: open.latest.version,
      effectiveTo: input.effectiveFrom,
    },
  };
}

/** Closes the last period on `effectiveTo`: from that day the code is not offered or priced. */
export function planTaxCodeRetire(
  periods: readonly TaxCodePeriodRow[],
  input: { effectiveTo: string; expectedVersion: number; today: string },
): PeriodPlan | PeriodRefusal {
  const open = openLatest(periods, input.expectedVersion);
  if (!open.ok) return open;
  if (input.effectiveTo < input.today) {
    return refuse(
      400,
      'A tax code cannot be retired before today: documents already issued keep their code.',
    );
  }
  if (input.effectiveTo <= open.latest.effectiveFrom) {
    return refuse(
      400,
      `Retire it after ${open.latest.effectiveFrom}, the day the current rate started.`,
    );
  }
  return {
    ok: true,
    close: { id: open.latest.id, version: open.latest.version, effectiveTo: input.effectiveTo },
  };
}
