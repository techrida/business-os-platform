/**
 * Version of the arithmetic in this package. Stored on every priced document so an old
 * invoice keeps the rounding rules it was issued under. Bump it only when a result for the
 * same input would change (P3 architect §3.5, door 7).
 */
export const CALC_VERSION = 1;
