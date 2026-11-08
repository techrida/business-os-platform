// The settings an admin may change, each with the schema its value must satisfy.
// Serves the NFR "configuration changes are versioned": the API validates against SETTINGS before
// writing a new row, so a bad value can never become the current one.
import { z } from 'zod';

import { SlaSpecSchema } from './approvals.js';
import { CurrencySchema, DecimalString } from './money.js';

export const SETTINGS = {
  /** Used when a workflow spec leaves its `sla` out. */
  'approvals.sla_defaults': SlaSpecSchema,
  /** Currencies a document may use. NPR is the books' currency, so it can never be switched off. */
  'currency.enabled': z
    .array(CurrencySchema)
    .min(1)
    .refine((list) => list.includes('NPR'), 'NPR must stay enabled')
    .refine((list) => new Set(list).size === list.length, 'currencies must be unique'),
  /** VAT as a percentage (13 means 13%), 0 to 100 with at most 2 decimals. */
  'tax.vat_rate': DecimalString.refine(
    (v) => Number(v) >= 0 && Number(v) <= 100,
    'must be 0 to 100',
  ),
  /** Prefix of memo numbers such as MEMO-2082/83-00001. */
  'numbering.memo_prefix': z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'use 2 to 10 capitals or digits'),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const SettingKeySchema = z.enum(Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]]);
