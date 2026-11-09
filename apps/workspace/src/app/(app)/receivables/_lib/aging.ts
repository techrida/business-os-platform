// Words for the aging buckets, and one text test for zero. The buckets themselves and every amount
// come from the server: nothing here adds, subtracts or converts money.
import type { AgingBucket } from '@bos/contracts';

/** A full record, so a bucket added to the contract is a compile error here until it is worded. */
export const BUCKET_LABEL: Record<AgingBucket, string> = {
  current: 'Not yet due',
  d1_30: '1 to 30 days',
  d31_60: '31 to 60 days',
  d61_90: '61 to 90 days',
  d91_plus: 'Over 90 days',
};

/**
 * True when a decimal string is zero. Read from the text, not through `Number`, so a value is never
 * turned into a float: it only decides whether a cell is drawn quietly.
 */
export function isZeroAmount(amount: string): boolean {
  return /^-?0+(\.0+)?$/.test(amount);
}
