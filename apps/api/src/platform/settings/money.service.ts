// NPR conversion and manual FX rates. Serves the NFR "amounts are exact and traceable": every foreign
// amount is frozen next to the rate, source and date that produced its NPR value, so a report run next
// year gives the same number, and an auditor can find the rate row a person entered.
//
// Rates are typed in by a person (no feed). The INR peg of 1.6 is just a row with source 'NRB peg'.
import { type Currency, type Money, type NprSnapshot, NprSnapshotSchema } from '@bos/contracts';
import { fxRates } from '@bos/db';
import { Dec, kathmanduDate } from '@bos/locale';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { readTxContext } from './settings.service';

/** Currencies that need a rate row. NPR is the books' currency and always converts at 1. */
export type FxCurrency = Exclude<Currency, 'NPR'>;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of the Kathmandu calendar day containing `on`. */
function kathmanduDateString(on: Date): string {
  const { y, m, d } = kathmanduDate(on);
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

@Injectable()
export class MoneyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The NPR value of `money` at the latest rate on or before the Kathmandu day of `on`.
   * Takes the Kathmandu day, not the UTC day: 2025-07-16T18:15Z is already 17 July in Nepal, and the
   * rate the accountant entered for 17 July must apply from local midnight.
   * Works on the plain db or inside a transaction, so a document can snapshot in its own transaction.
   */
  async toNprSnapshot(
    executor: Pick<Db, 'select'>,
    scope: TxScope,
    money: Money,
    on: Date,
  ): Promise<NprSnapshot> {
    const day = kathmanduDateString(on);

    let rate: string;
    let rateSource: string;
    let rateDate: string;
    if (money.currency === 'NPR') {
      rate = '1';
      rateSource = 'NPR';
      rateDate = day;
    } else {
      const [row] = await executor
        .select({ rate: fxRates.rateNpr, source: fxRates.source, rateDate: fxRates.rateDate })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.tenantId, scope.tenantId),
            eq(fxRates.currency, money.currency),
            lte(fxRates.rateDate, day),
          ),
        )
        .orderBy(desc(fxRates.rateDate))
        .limit(1);
      if (!row) {
        throw new ConflictException({
          code: 'conflict',
          message: `No NPR rate for ${money.currency} on or before ${day}`,
        });
      }
      // numeric(18,6) comes back as '1.600000'; Decimal drops the trailing zeros.
      rate = new Dec(row.rate).toFixed();
      rateSource = row.source ?? 'manual';
      rateDate = row.rateDate;
    }

    const amountNpr = new Dec(money.amount).times(rate).toDecimalPlaces(2).toFixed(2);
    return NprSnapshotSchema.parse({ amountNpr, rate, rateSource, rateDate });
  }

  /**
   * Records the rate of `currency` for `rateDate` for the whole tenant (a rate is a market fact, ADR 0027
   * section 7) inside the caller's transaction and returns its id.
   * ON CONFLICT DO NOTHING instead of catching the unique violation: in Postgres a violation aborts the
   * whole transaction, so the caller could not even roll back cleanly to report a 409. A rate is never
   * overwritten; to correct one, enter it for a later date.
   */
  async setRate(
    tx: DbTransaction,
    currency: FxCurrency,
    rateNpr: string,
    rateDate: string,
    source: string,
  ): Promise<{ id: string }> {
    const { tenantId, userId } = await readTxContext(tx, 'MoneyService.setRate');
    const [row] = await tx
      .insert(fxRates)
      .values({ tenantId, currency, rateNpr, rateDate, source, enteredBy: userId })
      // Name the target: a bare DO NOTHING would also swallow any other unique violation as "already exists".
      .onConflictDoNothing({ target: [fxRates.tenantId, fxRates.currency, fxRates.rateDate] })
      .returning({ id: fxRates.id });
    if (!row) {
      throw new ConflictException({
        code: 'conflict',
        message: `A ${currency} rate for ${rateDate} already exists`,
      });
    }
    return row;
  }

  /** Rates newest first, optionally for one currency. */
  async listRates(scope: TxScope, opts: { currency?: FxCurrency | undefined; limit: number }) {
    return this.db
      .select({
        id: fxRates.id,
        currency: fxRates.currency,
        rateNpr: fxRates.rateNpr,
        rateDate: fxRates.rateDate,
        source: fxRates.source,
        enteredBy: fxRates.enteredBy,
      })
      .from(fxRates)
      .where(
        and(
          eq(fxRates.tenantId, scope.tenantId),
          opts.currency ? eq(fxRates.currency, opts.currency) : undefined,
        ),
      )
      .orderBy(desc(fxRates.rateDate), desc(fxRates.currency))
      .limit(opts.limit);
  }
}
