// The typed reader of the delivery-hold release threshold (F1-Q32). Reads `sales.delivery_hold.management_npr`
// through SettingsService, so a company that never saved it gets the contract default, NPR 100,000.00 (D32).
// SalesOrdersService reads it live for `POST /v1/sales-orders/:id/delivery-release` and for the detail's
// `can.releaseDelivery`, and passes it to `mayReleaseDeliveryHold` in @bos/money-rules.
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
