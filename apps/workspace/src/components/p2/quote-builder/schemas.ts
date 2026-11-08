import {
  CurrencySchema,
  PaymentTermSchema,
  PreviewResultSchema,
  TaxCodeSchema,
  type PaymentTerm,
  type PreviewResult,
  type TaxCode,
} from '@bos/contracts';
import { z } from 'zod';

/**
 * The preview result and the two lookup lists live in `@bos/contracts` (quotations.ts); they are
 * re-exported here so the builder keeps one import path. Every response is parsed, so a drifting
 * API fails loudly (502).
 */
export { PaymentTermSchema, PreviewResultSchema, TaxCodeSchema };
export type { PaymentTerm, PreviewResult, TaxCode };

/** What a save returns: the new row version is all the builder keeps. */
export const SavedVersionSchema = z.object({ version: z.number().int().min(1) });

export { CurrencySchema };
