import {
  CurrencySchema,
  NprSnapshotSchema,
  QuotationLineDtoSchema,
  QuotationTaxSummaryItemSchema,
  QuotationTotalsSchema,
  RoutePlanSchema,
} from '@bos/contracts';
import { z } from 'zod';

/**
 * Shapes the quote builder needs that @bos/contracts does not define yet. They are local to the
 * builder, so the lead can move them into `packages/contracts/src/quotations.ts` when the API
 * lands (see the hand-back). Every response is parsed, so a drifting API fails loudly (502).
 */

/** `POST .../versions/:vid/preview`: server totals plus the approval route dry-run. */
export const PreviewResultSchema = z.object({
  totals: QuotationTotalsSchema,
  taxSummary: z.array(QuotationTaxSummaryItemSchema),
  /** Per-line figures the pricing function computed, when the API sends them. */
  lines: z
    .array(
      QuotationLineDtoSchema.pick({
        lineNo: true,
        gross: true,
        discountAlloc: true,
        taxable: true,
      }),
    )
    .optional(),
  /** The NPR equivalent and its rate, for INR and USD documents. */
  nprSnapshot: NprSnapshotSchema.nullable().optional(),
  /** Who must approve and why (`previewRoute` on the facts of this version). */
  route: RoutePlanSchema,
});
export type PreviewResult = z.infer<typeof PreviewResultSchema>;

export const TaxCodeSchema = z.object({
  id: z.guid(),
  /** Short name such as "VAT 13%". */
  label: z.string(),
  /** Percent, for the label only; the server does the tax maths. */
  rate: z.string().optional(),
});
export type TaxCode = z.infer<typeof TaxCodeSchema>;

export const PaymentTermSchema = z.object({ id: z.guid(), label: z.string() });
export type PaymentTerm = z.infer<typeof PaymentTermSchema>;

/** What a save returns: the new row version is all the builder keeps. */
export const SavedVersionSchema = z.object({ version: z.number().int().min(1) });

export { CurrencySchema };
