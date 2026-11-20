// Pure normalisers for the customers API. Serves the NFR "inputs are validated at the edge" and the duplicate
// search: name_norm, the PAN form the unique index holds and the LIKE pattern are all built here, so a test can
// pin them without a database.

/** Company-form words that say what kind of company it is, not which one. Same list as the workspace. */
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
 * A name reduced to what identifies the company: lower case, no punctuation, no company-form words
 * ("Himalayan Construction Pvt. Ltd." and "HIMALAYAN CONSTRUCTION PRIVATE LIMITED" match). This is a copy of
 * normalizeName in apps/workspace/src/components/p2/customers/duplicates.ts: the workspace asks the API for
 * `?q=<normalised name>`, so the two must give the same text. A name that is only form words keeps them.
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

/** The PAN or VAT number as stored: trimmed and upper-case (CHECK customers_pan_vat_no_check). */
export function normalizePan(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The PAN or VAT number as the duplicate check compares it: no spaces or hyphens, upper-case ("123-456-789" and
 * "123456789" match). A copy of normalizePanVat in apps/workspace/src/components/p2/customers/duplicates.ts, so
 * the server asks for a reason exactly where the form warns. Null when nothing is left.
 */
export function panMatchKey(value: string): string | null {
  const cleaned = value.replace(/[\s-]+/g, '').toUpperCase();
  return cleaned === '' ? null : cleaned;
}

/** The contact e-mail as stored: lower-case and trimmed (CHECK customer_contacts_email_norm_check). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Escapes `\`, `%` and `_` so that user text is matched literally inside a LIKE pattern. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * What `?q=` searches for: the normalised name against name_norm, and the text upper-cased against the PAN or
 * VAT number and the display number. `name` is null when the text has no letters or digits to match on.
 */
export function searchTerms(q: string): { name: string | null; code: string } {
  const name = normalizeName(q);
  return { name: name === '' ? null : name, code: q.trim().toUpperCase() };
}
