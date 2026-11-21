// The typed reader of the delivery-hold release threshold (F1-Q32). Reads `sales.delivery_hold.management_npr`
// with readSetting on the caller's executor, so a company that never saved it gets the contract default,
// NPR 100,000.00 (D32). SalesOrdersService reads it live, on its own transaction, for
// `POST /v1/sales-orders/:id/delivery-release` and for the detail's `can.releaseDelivery`, and passes it to
// `mayReleaseDeliveryHold` in @bos/money-rules. On the transaction, not through SettingsService.get: that takes a
// second pool connection while withTx holds the first, which can deadlock a busy pool.
import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { readSetting } from './settings.service';

/** The setting key the Settings screen edits. */
export const DELIVERY_HOLD_THRESHOLD_KEY = 'sales.delivery_hold.management_npr';

/** The NPR amount above which only Management may release a delivery hold, as a decimal string. */
export async function deliveryHoldThresholdNpr(
  q: Db | DbTransaction,
  scope: TxScope,
): Promise<string> {
  return (await readSetting(q, scope, DELIVERY_HOLD_THRESHOLD_KEY)).value;
}
