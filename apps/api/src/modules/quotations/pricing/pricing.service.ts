// Prices a quotation version inside the caller's transaction: tax code periods by issue date, the FX snapshot
// for INR and USD (MoneyService: 409 fx_rate_stale for an old USD rate, INR exempt on its peg), then the pure map
// in pricing.ts. Invalid input (an unknown tax code, a discount above the subtotal) answers 400, never 500.
import { BadRequestException, Injectable } from '@nestjs/common';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { priceQuotation, type FxSnapshot } from './pricing';
import type { PricedVersion, PricingInput } from './pricing.types';
import { loadTaxCodePeriods } from './tax-codes.resolver';

const NPR_FX: FxSnapshot = { rate: '1', source: null, date: null };

/** Midday in Kathmandu (UTC+05:45) on `day`, so MoneyService's Kathmandu-day rule lands on `day` itself. */
const kathmanduMidday = (day: string): Date => new Date(`${day}T12:00:00+05:45`);

@Injectable()
export class PricingService {
  constructor(private readonly money: MoneyService) {}

  async priceVersion(
    tx: DbTransaction,
    scope: TxScope,
    input: PricingInput,
  ): Promise<PricedVersion> {
    const periods = await loadTaxCodePeriods(
      tx,
      scope.tenantId,
      input.lines.map((line) => line.taxCodeId),
    );

    let fx = NPR_FX;
    if (input.currency !== 'NPR') {
      // Only the rate, source and date are used: the NPR amounts come from priceDocument's C-2 snapshot.
      const snapshot = await this.money.toNprSnapshot(
        tx,
        scope,
        { amount: '0.00', currency: input.currency },
        kathmanduMidday(input.issueDate),
      );
      fx = { rate: snapshot.rate, source: snapshot.rateSource, date: snapshot.rateDate };
    }

    try {
      return priceQuotation(input, periods, fx);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException({ code: 'bad_request', message: error.message });
      }
      throw error;
    }
  }
}
