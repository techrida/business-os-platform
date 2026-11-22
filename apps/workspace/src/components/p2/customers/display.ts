import {
  type AddressLines,
  type CountryCode,
  formatAddressLines,
  type PartyPhone,
} from '@bos/contracts';

/** Pure display helpers for the customer detail page. */

/**
 * A customer's address on one line: street, city and the country's name. The detail page always names the country;
 * leaving out the entity's own country is for printed documents only.
 */
export function addressText(address: AddressLines, country: CountryCode): string {
  return formatAddressLines(address, country).join(', ');
}

/** The number a person is reached on first: the primary one, else the first listed, else none. */
export function primaryPhone(phones: readonly PartyPhone[]): PartyPhone | null {
  return phones.find((phone) => phone.isPrimary) ?? phones[0] ?? null;
}
