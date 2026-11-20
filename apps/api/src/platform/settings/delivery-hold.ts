// The typed reader of the delivery-hold release threshold (F1-Q32). Reads `sales.delivery_hold.management_npr`
// through SettingsService, so a company that never saved it gets the contract default, NPR 100,000.00 (D32).
// The release action that uses it is not built yet; `deliveryHoldReleaser` in @bos/money-rules is the rule it
// will call with this value.
import type { TxScope } from '../db/tx';
import type { SettingsService } from './settings.service';

/** The setting key the Settings screen edits. */
export const DELIVERY_HOLD_THRESHOLD_KEY = 'sales.delivery_hold.management_npr';

/** The NPR amount above which only Management may release a delivery hold, as a decimal string. */
export async function deliveryHoldThresholdNpr(
  settings: Pick<SettingsService, 'get'>,
  scope: TxScope,
): Promise<string> {
  return settings.get(scope, DELIVERY_HOLD_THRESHOLD_KEY);
}
