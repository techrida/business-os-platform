// Who may release a hardware delivery hold (F1-Q32, decision D56; R4c1 Q4: the Founder may release too). Pure: no
// I/O. The NPR threshold is the `sales.delivery_hold.management_npr` setting (default 100,000.00); `fx.ts` owns the
// strict ">" so a threshold edge is not above itself, as for the approval bands.
import { exceedsApprovalThresholdNpr } from './fx.js';
import { type Dec, parseDecimal } from './money.js';

/** A role that may release a delivery hold. The strings match the platform's role keys. */
export type DeliveryHoldReleaserRole = 'finance' | 'management' | 'founder';

/**
 * The roles that may release a hold on a delivery worth `amountNpr` (NPR, the order amount the hold guards).
 * Up to and including `thresholdNpr` it is Finance; above it, Management. The Founder may release at any amount.
 * 100,000.00 is Finance (or Founder) and 100,000.01 is Management (or Founder) with the default threshold.
 */
export function deliveryHoldReleaser(
  amountNpr: Dec,
  thresholdNpr: string,
): readonly DeliveryHoldReleaserRole[] {
  if (parseDecimal(thresholdNpr).isNegative()) {
    throw new RangeError('The delivery-hold threshold cannot be negative.');
  }
  return exceedsApprovalThresholdNpr(amountNpr, thresholdNpr)
    ? ['management', 'founder']
    : ['finance', 'founder'];
}

export interface DeliveryHoldRelease {
  amountNpr: Dec;
  /** `sales.delivery_hold.management_npr`, as settings text. */
  thresholdNpr: string;
  /**
   * The user who asked for the delivery. They may never release its hold, whatever roles they hold (separation of
   * duties: the requester is not the releaser), and that includes a Founder. (This pure rule stays strict; the small-team exception, a lone Founder with a
   * written reason when nobody else may release, is decided by the sales-order service, F1-Q11.) For a sales order this is
   * `sales_orders.created_by`: the person who turned the accepted quotation into the order and so asked for it to
   * be delivered. Null (an order created by the system, or a creator since removed) excludes nobody: only the role
   * rule applies.
   */
  requestedByUserId: string | null;
  /** The user trying to release the hold, with the role keys they hold. */
  releaser: { userId: string; roles: readonly string[] };
}

/** True when `releaser` holds a role `deliveryHoldReleaser` allows and is not the person who requested the delivery. */
export function mayReleaseDeliveryHold(input: DeliveryHoldRelease): boolean {
  if (input.requestedByUserId !== null && input.releaser.userId === input.requestedByUserId)
    return false;
  const allowed = deliveryHoldReleaser(input.amountNpr, input.thresholdNpr);
  return allowed.some((role) => input.releaser.roles.includes(role));
}
