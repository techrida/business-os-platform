import type { Address } from '@bos/contracts';

/** Pure display helpers for the customer detail page. */

/** Which part of the address a line shows. Stable per address, so it is the React key. */
export type AddressSlot = 'line1' | 'line2' | 'place' | 'postal';

export interface AddressLine {
  slot: AddressSlot;
  text: string;
}

/**
 * An address as one line per part that is set, in the order people write it. Two parts can show
 * the same text (line 1 "KTM" and city "KTM"), so callers key lines by `slot`, never by text.
 */
export function addressLines(a: Address): AddressLine[] {
  const place = [a.city, a.district, a.province].filter((p): p is string => Boolean(p));
  const last = [a.postalCode, a.country].filter((p): p is string => Boolean(p));
  const lines: { slot: AddressSlot; text: string | undefined }[] = [
    { slot: 'line1', text: a.line1 },
    { slot: 'line2', text: a.line2 },
    { slot: 'place', text: place.join(', ') },
    { slot: 'postal', text: last.join(' ') },
  ];
  return lines.filter((l): l is AddressLine => l.text !== undefined && l.text !== '');
}
