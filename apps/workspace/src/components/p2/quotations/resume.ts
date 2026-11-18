import type { QuotationListItem } from '@bos/contracts';

/**
 * Which quotation entry an opportunity offers, so a saved draft is resumed instead of a second
 * quotation being started (demo 2026-11-17: four quotations were made for one opportunity).
 * Only rows the server marked `canEdit` count: a Draft or Returned quotation this caller may edit.
 *
 * - exactly one: resume it (Edit quotation, and the New URL opens its editor);
 * - several: let the person choose from the opportunity's list, with New as a secondary action;
 * - none: start a new one.
 */
export type QuotationEntry =
  | { kind: 'resume'; quotationId: string; number: string }
  | { kind: 'choose'; count: number }
  | { kind: 'new' };

export function quotationEntryFor(items: readonly QuotationListItem[]): QuotationEntry {
  const editable = items.filter((q) => q.canEdit);
  if (editable.length === 1) {
    const [only] = editable;
    return { kind: 'resume', quotationId: only!.id, number: only!.number };
  }
  if (editable.length > 1) return { kind: 'choose', count: editable.length };
  return { kind: 'new' };
}

/** The editor of one quotation. */
export const editQuotationHref = (quotationId: string): string =>
  `/quotations/${encodeURIComponent(quotationId)}/edit`;

/** The quotations of one opportunity. */
export const opportunityQuotationsHref = (opportunityId: string): string =>
  `/quotations?${new URLSearchParams({ opportunityId }).toString()}`;

/**
 * The new-quotation builder for an opportunity. `another` is the deliberate "start another one"
 * from the opportunity's list: without it, the page resumes an editable draft instead.
 */
export function newQuotationHref(opportunityId: string, { another = false } = {}): string {
  const params = new URLSearchParams({ opportunityId });
  if (another) params.set('another', '1');
  return `/quotations/new?${params.toString()}`;
}
