// The portal APIs return a customer's whole derived list (no query params), so the pages filter
// the fetched rows here. That is only acceptable because the list is one party's own documents.

/** Case-insensitive "contains" over the searchable fields; no search means everything matches. */
export function matchesText(
  q: string | undefined,
  fields: readonly (string | null | undefined)[],
): boolean {
  if (!q) return true;
  const needle = q.toLocaleLowerCase('en');
  return fields.some((field) => field?.toLocaleLowerCase('en').includes(needle));
}

/** An empty selection means "all". */
export function matchesSelection(selected: readonly string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}
