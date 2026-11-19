/**
 * LIMIT for a list called without a `limit`: larger than any table can be, so every match is returned.
 * Postgres' `integer` maximum, because the page query's `limit` is a number, not "absent".
 */
export const NO_LIMIT = 2_147_483_647;
