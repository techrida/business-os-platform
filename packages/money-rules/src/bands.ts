// Approval bands by NPR amount (P4 AD4). Pure: no I/O. `fx.ts` owns the amount and the strict ">".
import { exceedsApprovalThresholdNpr } from './fx.js';
import { type Dec, parseDecimal } from './money.js';

/** The band an amount falls in: the highest approval it needs beyond the usual chain. */
export type ApprovalBand = 'none' | 'management' | 'founder';

/** `procurement.band.management_npr` and `procurement.band.founder_npr`, as settings text. */
export interface BandThresholds {
  managementNpr: string;
  founderNpr: string;
}

/** AD4: above 100,000.00 adds Management; above 1,000,000.00 adds Founder. */
export const DEFAULT_BAND_THRESHOLDS: BandThresholds = {
  managementNpr: '100000',
  founderNpr: '1000000',
};

/**
 * The band for an `amountNpr` (grand total incl. VAT, before TDS, in NPR; see `fx.ts`). A band
 * edge is not above itself: 100,000.00 is `none`, 100,000.01 is `management`. A founder amount
 * also needs Management, so the result is the highest band reached.
 */
export function bandFor(
  amountNpr: Dec,
  thresholds: BandThresholds = DEFAULT_BAND_THRESHOLDS,
): ApprovalBand {
  if (!parseDecimal(thresholds.founderNpr).gte(parseDecimal(thresholds.managementNpr))) {
    throw new RangeError('The founder threshold cannot be below the management threshold.');
  }
  if (exceedsApprovalThresholdNpr(amountNpr, thresholds.founderNpr)) return 'founder';
  if (exceedsApprovalThresholdNpr(amountNpr, thresholds.managementNpr)) return 'management';
  return 'none';
}
