import type { CustomerDto } from '@bos/contracts';

import { normalizeName, normalizePanVat, type DuplicateReason } from './duplicates';

/**
 * Pure helpers for the advisory duplicate check on "Add customer". The check warns and never
 * blocks. The API's `?q=` search is fuzzy, so the page asks it for candidates and this file keeps
 * only the ones that really are the same name or the same PAN/VAT after normalising.
 */

/** A name shorter than this is too common to search on. */
const MIN_QUERY = 2;

/** The `?q=` searches to run: the name without company-form words, and the PAN/VAT as typed. */
export function duplicateQueries(legalName: string, panVatNo: string | undefined): string[] {
  const queries: string[] = [];
  const name = normalizeName(legalName);
  if (name.length >= MIN_QUERY) queries.push(name);
  const pan = panVatNo?.trim() ?? '';
  if (pan.length >= MIN_QUERY) queries.push(pan);
  return queries;
}

export interface DuplicateMatch {
  id: string;
  number: string;
  legalName: string;
  panVatNo: string | null;
  reasons: DuplicateReason[];
}

/**
 * Which `candidates` are the same company as the one being typed. Records merged into another are
 * skipped (the live record is the one worth warning about), and so is `excludeId` (the customer
 * being edited). Two reasons rank above one; ties keep the order the API sent.
 */
export function matchDuplicates(
  input: { legalName: string; panVatNo?: string | undefined },
  candidates: readonly CustomerDto[],
  options: { excludeId?: string; limit?: number } = {},
): DuplicateMatch[] {
  const name = normalizeName(input.legalName);
  const pan = normalizePanVat(input.panVatNo ?? null);
  if (name === '' && pan === null) return [];

  const seen = new Set<string>();
  const found: DuplicateMatch[] = [];
  for (const c of candidates) {
    if (c.id === options.excludeId || c.mergedIntoId !== null || seen.has(c.id)) continue;
    seen.add(c.id);
    const reasons: DuplicateReason[] = [];
    if (pan !== null && normalizePanVat(c.panVatNo) === pan) reasons.push('pan_vat');
    if (name !== '' && normalizeName(c.legalName) === name) reasons.push('name');
    if (reasons.length > 0) {
      found.push({
        id: c.id,
        number: c.number,
        legalName: c.legalName,
        panVatNo: c.panVatNo,
        reasons,
      });
    }
  }
  found.sort((a, b) => b.reasons.length - a.reasons.length);
  return found.slice(0, options.limit ?? 5);
}
