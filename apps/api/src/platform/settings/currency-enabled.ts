// The one check that a document's currency is switched on for the company (D44). Reads the
// `currency.enabled` setting through SettingsService, so nothing saved means the contract default applies.
// NPR is the books' currency and is always accepted, even if an old saved list somehow left it out.
// A missing currency (optional on leads and opportunities) is accepted: there is nothing to check.
import { Injectable, UnprocessableEntityException } from '@nestjs/common';

import type { TxScope } from '../db/tx';
import { SettingsService } from './settings.service';

/** 422 CURRENCY_NOT_ENABLED: the company has not switched this currency on in Settings. */
export const currencyNotEnabled = (currency: string) =>
  new UnprocessableEntityException({
    code: 'CURRENCY_NOT_ENABLED',
    message: `Currency ${currency} is not enabled for this company`,
    details: { currency },
  });

/** The first currency in `currencies` that `enabled` does not allow, or undefined when all pass. */
function firstNotEnabled(
  enabled: readonly string[],
  currencies: readonly (string | null | undefined)[],
): string | undefined {
  return currencies.find((c): c is string => c != null && c !== 'NPR' && !enabled.includes(c));
}

@Injectable()
export class CurrencyEnabledService {
  constructor(private readonly settings: SettingsService) {}

  /** Throws 422 CURRENCY_NOT_ENABLED unless `currency` is null/undefined, NPR, or in `currency.enabled`. */
  async assertEnabled(scope: TxScope, currency: string | null | undefined): Promise<void> {
    await this.assertAllEnabled(scope, [currency]);
  }

  /** Same as `assertEnabled` for every entry, reading the setting once; reports the first refused one. */
  async assertAllEnabled(
    scope: TxScope,
    currencies: readonly (string | null | undefined)[],
  ): Promise<void> {
    if (currencies.every((c) => c == null || c === 'NPR')) return;
    const enabled = await this.settings.get(scope, 'currency.enabled');
    const refused = firstNotEnabled(enabled, currencies);
    if (refused !== undefined) throw currencyNotEnabled(refused);
  }
}
