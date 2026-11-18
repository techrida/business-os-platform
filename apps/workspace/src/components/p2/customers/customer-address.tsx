import type { Address } from '@bos/contracts';

import { addressLines } from './display';

/** A customer's address, one span per line. Keyed by slot: two lines may read the same. */
export function CustomerAddress({
  address,
  className,
}: {
  address: Address;
  className?: string | undefined;
}) {
  return (
    <span className={className}>
      {addressLines(address).map((line) => (
        <span key={line.slot}>{line.text}</span>
      ))}
    </span>
  );
}
