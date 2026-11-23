// The NPR value a credit note takes on a foreign-currency original. Each partial credit's NPR is the original's NPR
// times the share of the original's total credited so far, rounded half up to the cent, less the NPR the earlier credit
// notes already took. The cumulative NPR therefore always equals round(original NPR x credited / total), so the credit
// that brings the credited total to the original's total takes exactly what is left and the NPR values net to 0, with
// no step rounding of its own that could leave 0.00 or a negative remainder (a 0.06 INR invoice at 1.6, credited in
// five 0.01 steps, used to leave 0.00 for the closing credit).
import { Dec } from '@bos/money-rules';

/** Half up to two decimals, as money rule D22. */
const cents = (value: Dec): Dec => value.toDecimalPlaces(2, Dec.ROUND_HALF_UP);

/**
 * The NPR of a credit note of `noteTotal` on an original of `originalTotal` / `originalNpr`, when the issued notes
 * before it credited `creditedBefore` (document currency) and took `creditedNprBefore` NPR. Unsigned magnitudes, two
 * decimals. `creditedBefore + noteTotal` must not exceed `originalTotal` (the issue cap checks that first).
 */
export function creditNoteNpr(input: {
  originalTotal: Dec;
  originalNpr: Dec;
  creditedBefore: Dec;
  creditedNprBefore: Dec;
  noteTotal: Dec;
}): Dec {
  const { originalTotal, originalNpr, creditedBefore, creditedNprBefore, noteTotal } = input;
  const creditedAfter = creditedBefore.plus(noteTotal);
  if (creditedAfter.gte(originalTotal)) return originalNpr.minus(creditedNprBefore);
  return cents(originalNpr.times(creditedAfter).dividedBy(originalTotal)).minus(creditedNprBefore);
}
