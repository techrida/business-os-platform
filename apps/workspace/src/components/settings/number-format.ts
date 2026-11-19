// Pure helpers for Settings > Number and date format. No React, so the worked examples can be
// tested without rendering. The examples come from the same formatters the documents use.
import {
  NUMBER_SYSTEM_LABELS,
  NUMBER_SYSTEM_VALUES,
  NumberSystemSchema,
  type NumberSystemSetting,
} from '@bos/contracts';
import { amountInWords, formatMoney } from '@bos/locale';

/** One amount that reads differently in the two systems (twenty lakh vs two million). */
export const NUMBER_FORMAT_SAMPLE = '2018180';

export interface NumberSystemOption {
  value: NumberSystemSetting;
  name: string;
  /** The sample amount as printed, for example `NPR 20,18,180.00`. */
  amount: string;
  /** The same amount spelled out, as it ends the totals block of a document. */
  words: string;
}

/** The two choices with their live worked examples. */
export function numberSystemOptions(): NumberSystemOption[] {
  return NUMBER_SYSTEM_VALUES.map((value) => ({
    value,
    name: NUMBER_SYSTEM_LABELS[value].name,
    amount: formatMoney(NUMBER_FORMAT_SAMPLE, 'NPR', { numberSystem: value }),
    words: amountInWords(NUMBER_FORMAT_SAMPLE, 'NPR', value),
  }));
}

/** A submitted or stored value as a number system, or null when it is neither. */
export function parseNumberSystem(raw: unknown): NumberSystemSetting | null {
  const parsed = NumberSystemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
