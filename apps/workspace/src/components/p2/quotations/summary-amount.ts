import type { QuotationAmount, QuotationStatus, QuotationSummary } from '@bos/contracts';

/**
 * What the quotations in one status are worth, when that is one honest number: exactly one
 * currency and more than zero. Mixed currencies are never added or converted here, so the card
 * shows its count alone; an older API that sends no amounts does the same.
 */
export function statusWorth(
  summary: QuotationSummary,
  status: QuotationStatus,
): QuotationAmount | null {
  const entries = summary.amounts?.[status] ?? [];
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only === undefined) return null;
  return Number(only.total) > 0 ? only : null;
}
