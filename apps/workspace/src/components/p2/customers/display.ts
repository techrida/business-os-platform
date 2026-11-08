import type { Address } from '@bos/contracts';

/** Pure display helpers for the customer detail page. */

/** An address as one line per part that is set, in the order people write it. */
export function addressLines(a: Address): string[] {
  const place = [a.city, a.district, a.province].filter((p): p is string => Boolean(p));
  const last = [a.postalCode, a.country].filter((p): p is string => Boolean(p));
  return [a.line1, a.line2, place.join(', '), last.join(' ')].filter(
    (l): l is string => l !== undefined && l !== '',
  );
}
