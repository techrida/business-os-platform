import 'server-only';

import { TaxCodeSchema, type TaxCode } from '@bos/contracts';
import { z } from 'zod';

import { call } from './api-procurement';
import type { Session } from './session';

const taxCodes = z.union([
  z.array(TaxCodeSchema),
  z.object({ items: z.array(TaxCodeSchema) }).transform((body) => body.items),
]);

/** Shared registry for quotation, sourcing and bill entry. */
export function listTaxCodes(session: Session): Promise<TaxCode[]> {
  return call(session, '/v1/tax-codes', taxCodes);
}
