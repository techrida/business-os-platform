import type { AddressLines, CountryCode } from '@bos/contracts';

import { addressText } from './display';

/** A customer's address as one line: street, city and country name. */
export function CustomerAddress({
  address,
  country,
  className,
}: {
  address: AddressLines;
  country: CountryCode;
  className?: string | undefined;
}) {
  return <span className={className}>{addressText(address, country)}</span>;
}
