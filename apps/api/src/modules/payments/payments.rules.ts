// Pure rules of customer payments, kept apart from PaymentsService so the unit tests need no database.

/**
 * What two bank references are compared on for the reused-reference warning (TR-Q12d): spaces at either end do not
 * count, a run of spaces counts as one and case does not count, so "NIC  77812" and " nic 77812 " are the same
 * reference. Empty for a reference with nothing but spaces, which matches nothing.
 */
export function bankReferenceKey(reference: string): string {
  return reference.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The rows whose bank reference has the same key as `reference`, in their order; none when it has no key. */
export function sameReferencePayments<T extends { bankReference: string | null }>(
  reference: string,
  rows: readonly T[],
): T[] {
  const key = bankReferenceKey(reference);
  if (key === '') return [];
  return rows.filter((r) => r.bankReference !== null && bankReferenceKey(r.bankReference) === key);
}
