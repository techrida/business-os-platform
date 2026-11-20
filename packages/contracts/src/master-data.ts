// Tax codes and payment terms as Settings edits them (F1-Q49): `/v1/admin/tax-codes` and `/v1/admin/payment-terms`,
// open to settings.finance.write (Finance, Accountant) and admin.settings.write (the Founder).
//
// Issued documents never change:
// - A tax code is a series of dated periods (C-8). A rate, name or creditable change is a new period from a day no
//   earlier than today; the current period is closed that day, never edited. Retiring closes the last period. A
//   document names the period row it was priced with, so its rate stays.
// - A payment term keeps its days for life (sales orders, vendor bills and purchase requests read them); a
//   different period is a new term. Its name can be corrected, and it can be retired and restored.
import { z } from 'zod';

import { TaxCodeKindSchema } from './quotations.js';

/** A tax rate in percent, 0 to 100 with up to two decimals: "13", "6.5", "0.01". */
export const TaxRatePercentSchema = z
  .string()
  .trim()
  .regex(/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/, 'Enter 0 to 100 with up to two decimals');

/** Percent text to basis points, exactly (no floating point): "13" is 1300, "6.5" is 650, "0.01" is 1. */
export function percentToBasisPoints(rate: string): number {
  const [whole = '0', fraction = ''] = rate.trim().split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Basis points to percent text without trailing zeros: 1300 is "13", 650 is "6.5", 1 is "0.01". */
export function basisPointsToPercent(rateBp: number): string {
  const whole = Math.floor(rateBp / 100);
  const fraction = String(rateBp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${whole}.${fraction}`;
}

/** True when the rate suits the kind: exempt and zero-rated codes are 0, VAT and reverse charge are above 0. */
export function taxRateFitsKind(kind: z.infer<typeof TaxCodeKindSchema>, rateBp: number): boolean {
  return (kind === 'exempt' || kind === 'zero') === (rateBp === 0);
}

export const TAX_RATE_KIND_MESSAGE =
  'Exempt and zero-rated codes have a 0% rate; VAT and reverse-charge codes need a rate above 0%.';

/** A tax code's short code, as documents and exports show it: capitals, digits, `-` or `_`, up to 20. */
export const TaxCodeCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use 1 to 20 capitals, digits, - or _');

export const MasterDataNameSchema = z.string().trim().min(1).max(80);

/** A calendar day, YYYY-MM-DD, read in Asia/Kathmandu. */
const Day = z.iso.date();

/** One dated period of a tax code: [effectiveFrom, effectiveTo), effectiveTo null is open-ended. */
export const TaxCodePeriodSchema = z.object({
  id: z.guid(),
  name: z.string(),
  /** Percent text, for display. */
  rate: z.string(),
  rateBp: z.number().int().min(0).max(10000),
  creditable: z.boolean(),
  effectiveFrom: Day,
  /** Exclusive: the first day the period no longer applies. */
  effectiveTo: Day.nullable(),
  version: z.number().int().min(1),
});
export type TaxCodePeriod = z.infer<typeof TaxCodePeriodSchema>;

/** One tax code with every period, oldest first. */
export const AdminTaxCodeSchema = z.object({
  code: z.string(),
  kind: TaxCodeKindSchema,
  periods: z.array(TaxCodePeriodSchema).min(1),
  /** The period in force today, or null (not started yet, or retired). */
  current: TaxCodePeriodSchema.nullable(),
  /** A period that starts after today, if one is scheduled. */
  next: TaxCodePeriodSchema.nullable(),
  /** The day the code stops applying (the last period's end), or null when it is open-ended. */
  endsOn: Day.nullable(),
  /** The last period: the one a change or a retirement acts on, with the version to send back. */
  latest: TaxCodePeriodSchema,
});
export type AdminTaxCode = z.infer<typeof AdminTaxCodeSchema>;

/** `POST /v1/admin/tax-codes`: a new code, in force from `effectiveFrom` (today or later). */
export const CreateTaxCodeBodySchema = z
  .strictObject({
    code: TaxCodeCodeSchema,
    name: MasterDataNameSchema,
    kind: TaxCodeKindSchema,
    rate: TaxRatePercentSchema,
    creditable: z.boolean(),
    effectiveFrom: Day,
  })
  .refine((b) => taxRateFitsKind(b.kind, percentToBasisPoints(b.rate)), {
    message: TAX_RATE_KIND_MESSAGE,
    path: ['rate'],
  });
export type CreateTaxCodeBody = z.infer<typeof CreateTaxCodeBodySchema>;

/**
 * `POST /v1/admin/tax-codes/:code/changes`: a new period from `effectiveFrom` (today or later, after the last period
 * started). The last period is closed that day. `expectedVersion` is the last period's version as loaded.
 */
export const ChangeTaxCodeBodySchema = z.strictObject({
  name: MasterDataNameSchema,
  rate: TaxRatePercentSchema,
  creditable: z.boolean(),
  effectiveFrom: Day,
  expectedVersion: z.number().int().min(1),
});
export type ChangeTaxCodeBody = z.infer<typeof ChangeTaxCodeBodySchema>;

/** `POST /v1/admin/tax-codes/:code/retire`: the code stops applying from `effectiveTo` (today or later). */
export const RetireTaxCodeBodySchema = z.strictObject({
  effectiveTo: Day,
  expectedVersion: z.number().int().min(1),
});
export type RetireTaxCodeBody = z.infer<typeof RetireTaxCodeBodySchema>;

/** A payment term's short code: capitals, digits, `-` or `_`, up to 20. */
export const PaymentTermCodeSchema = TaxCodeCodeSchema;

export const AdminPaymentTermSchema = z.object({
  id: z.guid(),
  code: z.string(),
  name: z.string(),
  netDays: z.number().int().min(0).max(365),
  retired: z.boolean(),
  version: z.number().int().min(1),
});
export type AdminPaymentTerm = z.infer<typeof AdminPaymentTermSchema>;

/** `POST /v1/admin/payment-terms`. The days are fixed once created. */
export const CreatePaymentTermBodySchema = z.strictObject({
  code: PaymentTermCodeSchema,
  name: MasterDataNameSchema,
  netDays: z.number().int().min(0).max(365),
});
export type CreatePaymentTermBody = z.infer<typeof CreatePaymentTermBodySchema>;

/** `PATCH /v1/admin/payment-terms/:id`: correct the name and/or retire or restore. */
export const UpdatePaymentTermBodySchema = z
  .strictObject({
    name: MasterDataNameSchema.optional(),
    retired: z.boolean().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine((b) => b.name !== undefined || b.retired !== undefined, 'nothing to change');
export type UpdatePaymentTermBody = z.infer<typeof UpdatePaymentTermBodySchema>;
