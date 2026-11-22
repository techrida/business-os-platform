// Structured addresses (FX9): a free-text Address (street lines), a City and a Country. The party's country is its
// own field, so the stored lines carry only `line` and `city`; a printed address adds the country.
// This module must not import crm.ts or document-style.ts: document-style imports crm.
import { z } from 'zod';

import { type CountryCode, CountryCodeSchema, countryName } from './countries.js';

/** The street lines and city of an address. The country lives on the party. */
export const AddressLinesSchema = z.strictObject({
  line: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(100),
});
export type AddressLines = z.infer<typeof AddressLinesSchema>;

/** An address as a document prints it: lines, city and country together. */
export const PrintAddressSchema = z.strictObject({
  line: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(100),
  country: CountryCodeSchema,
});
export type PrintAddress = z.infer<typeof PrintAddressSchema>;

/**
 * The lines a document prints for an address: street, city, then the country's name. The country is left out when
 * it is `ownCountry` (the issuing entity's own), as a domestic letter would.
 */
export function formatAddressLines(
  address: { line: string; city: string },
  country: CountryCode,
  ownCountry?: CountryCode,
): string[] {
  const lines = [address.line, address.city];
  if (country !== ownCountry) lines.push(countryName(country));
  return lines;
}
