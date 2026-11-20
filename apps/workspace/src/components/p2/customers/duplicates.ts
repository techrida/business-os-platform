/**
 * Pure helpers for the customer list: spotting records that may be the same company, and reading
 * the page number from the query string. No server code, so a test or a Client Component can use it.
 */

/** Company-form words that say what kind of company it is, not which one. */
const FORM_WORDS = new Set([
  'pvt',
  'ltd',
  'private',
  'limited',
  'co',
  'company',
  'inc',
  'llc',
  'प्रा',
  'लि',
]);

/**
 * A name reduced to what identifies the company: lower case, no punctuation, no company-form
 * words ("Himalayan Construction Pvt. Ltd." and "HIMALAYAN CONSTRUCTION PRIVATE LIMITED" match).
 * It warns and never blocks, so it errs toward matching. A name that is only form words keeps them.
 */
export function normalizeName(name: string): string {
  const words = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(\s*p\s*\)/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const kept = words.filter((w) => !FORM_WORDS.has(w));
  return (kept.length > 0 ? kept : words).join(' ');
}

/** A PAN or VAT number without case, spaces or hyphens; null when there is nothing to compare. */
export function normalizePanVat(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(/[\s-]+/g, '').toUpperCase();
  return cleaned === '' ? null : cleaned;
}

export type DuplicateReason = 'pan_vat' | 'name';

interface Comparable {
  id: string;
  legalName: string;
  panVatNo: string | null;
}

/**
 * Which records in `customers` look like another record in the same list, and why. A record is
 * never compared with itself. Only the records on the page are compared: the API does the wider
 * check when one is created.
 */
export function findDuplicates(customers: readonly Comparable[]): Map<string, DuplicateReason[]> {
  const byPan = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const c of customers) {
    const pan = normalizePanVat(c.panVatNo);
    if (pan !== null) byPan.set(pan, [...(byPan.get(pan) ?? []), c.id]);
    const name = normalizeName(c.legalName);
    if (name !== '') byName.set(name, [...(byName.get(name) ?? []), c.id]);
  }
  const found = new Map<string, DuplicateReason[]>();
  for (const c of customers) {
    const reasons: DuplicateReason[] = [];
    const pan = normalizePanVat(c.panVatNo);
    if (pan !== null && (byPan.get(pan)?.length ?? 0) > 1) reasons.push('pan_vat');
    if ((byName.get(normalizeName(c.legalName))?.length ?? 0) > 1) reasons.push('name');
    if (reasons.length > 0) found.set(c.id, reasons);
  }
  return found;
}
