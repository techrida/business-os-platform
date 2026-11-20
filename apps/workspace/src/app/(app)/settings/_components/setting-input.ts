// Turns what a settings form submitted into a value for PUT /v1/admin/settings/:key. Serves the NFR
// "configuration changes are versioned": the value is checked against the shared SETTINGS schema
// here, so the admin sees the problem next to the field; the API checks it again and is the authority.
import {
  PercentFourDecimals,
  SETTINGS,
  ScheduleTriggerSchema,
  type SettingKey,
} from '@bos/contracts';
import type { z } from 'zod';

import { isDefaultValue } from '@/components/settings/default-value';

import { scheduleSummary, type SettingFieldValue } from './setting-fields';

export type SettingInput = { ok: true; value: unknown } | { ok: false; message: string };

const WHOLE_NUMBER = /^[0-9]+$/;

function isTypedValue(input: SettingFieldValue | readonly string[]): input is SettingFieldValue {
  return !Array.isArray(input);
}

function parseWholeNumber(
  raw: string,
  message: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!WHOLE_NUMBER.test(trimmed)) return { ok: false, message };
  return { ok: true, value: Number(trimmed) };
}

function parseTypedField(key: SettingKey, input: SettingFieldValue): SettingInput {
  switch (key) {
    case 'currency.enabled': {
      if (input.kind !== 'currencies')
        return { ok: false, message: 'Select at least one currency.' };
      return validateAgainstSchema(key, [...input.values]);
    }
    case 'approvals.sla_defaults': {
      if (input.kind !== 'sla')
        return { ok: false, message: 'Enter valid reminder and escalation times.' };
      const remind = parseWholeNumber(
        input.value.remindAfterHours,
        'Remind after must be a whole number of hours (at least 1).',
      );
      if (!remind.ok) return remind;
      if (remind.value < 1) {
        return { ok: false, message: 'Remind after must be at least 1 hour.' };
      }
      const escalate = parseWholeNumber(
        input.value.escalateAfterHours,
        'Escalate after must be a whole number of hours (at least 1).',
      );
      if (!escalate.ok) return escalate;
      if (escalate.value < 1) {
        return { ok: false, message: 'Escalate after must be at least 1 hour.' };
      }
      if (escalate.value <= remind.value) {
        return { ok: false, message: 'Escalate after must be later than remind after.' };
      }
      return validateAgainstSchema(key, {
        remindAfterHours: remind.value,
        escalateAfterHours: escalate.value,
        escalateTo: { role: input.value.escalateToRole },
      });
    }
    case 'sales.default_schedule': {
      if (input.kind !== 'schedule')
        return { ok: false, message: 'Enter a valid billing schedule.' };
      if (input.rows.length === 0) return { ok: false, message: 'Add at least one billing row.' };
      if (input.rows.length > 12) return { ok: false, message: 'Use at most 12 billing rows.' };
      for (const row of input.rows) {
        const label = row.label.trim();
        if (label === '') return { ok: false, message: 'Enter a label for every row.' };
        if (label.length > 100) {
          return { ok: false, message: 'Each row label must be 100 characters or fewer.' };
        }
        const pct = row.percent.trim();
        if (!PercentFourDecimals.safeParse(pct).success) {
          return { ok: false, message: 'Enter a percentage from 0 to 100 for every row.' };
        }
        if (!ScheduleTriggerSchema.safeParse(row.trigger).success) {
          return { ok: false, message: 'Choose a valid billing trigger for every row.' };
        }
      }
      const summary = scheduleSummary(input.rows);
      if (summary.status === 'short' || summary.status === 'over') {
        return {
          ok: false,
          message: `Percentages must add up to 100%. ${summary.actionText}.`,
        };
      }
      if (summary.status === 'invalid') {
        return { ok: false, message: 'Enter a percentage from 0 to 100 for every row.' };
      }
      const serialised = input.rows.map((row) => ({
        label: row.label.trim(),
        percent: row.percent.trim(),
        trigger: row.trigger,
      }));
      return validateAgainstSchema(key, serialised);
    }
    case 'fx.max_rate_age_days':
    case 'quotation.validity_days': {
      if (input.kind !== 'text')
        return { ok: false, message: 'Enter a whole number of days, such as 7.' };
      const parsed = parseWholeNumber(input.value, 'Enter a whole number of days, such as 7.');
      if (!parsed.ok) return parsed;
      if (parsed.value < 1 || parsed.value > 365) {
        return { ok: false, message: 'Enter a whole number from 1 to 365.' };
      }
      return validateAgainstSchema(key, parsed.value);
    }
    case 'procurement.min_quotes': {
      if (input.kind !== 'text')
        return { ok: false, message: 'Enter a whole number of quotes, such as 3.' };
      const parsed = parseWholeNumber(input.value, 'Enter a whole number of quotes, such as 3.');
      if (!parsed.ok) return parsed;
      if (parsed.value < 1 || parsed.value > 10) {
        return { ok: false, message: 'Enter a whole number from 1 to 10.' };
      }
      return validateAgainstSchema(key, parsed.value);
    }
    case 'tax.vat_rate':
    case 'procurement.match.qty_pct':
    case 'procurement.match.price_pct': {
      if (input.kind !== 'text') {
        return {
          ok: false,
          message: 'Enter a percentage from 0 to 100 with up to two decimal places.',
        };
      }
      const trimmed = input.value.trim();
      const result = validateAgainstSchema(key, trimmed);
      if (!result.ok) {
        return {
          ok: false,
          message: 'Enter a percentage from 0 to 100 with up to two decimal places.',
        };
      }
      return result;
    }
    case 'procurement.match.price_npr':
    case 'procurement.band.management_npr':
    case 'procurement.band.founder_npr':
    case 'sales.delivery_hold.management_npr': {
      if (input.kind !== 'text') {
        return {
          ok: false,
          message: 'Enter an amount of 0 or more with up to two decimal places.',
        };
      }
      const trimmed = input.value.trim();
      const result = validateAgainstSchema(key, trimmed);
      if (!result.ok) {
        return {
          ok: false,
          message: 'Enter an amount of 0 or more with up to two decimal places.',
        };
      }
      return result;
    }
    case 'entity.pan_vat_no': {
      if (input.kind !== 'text') return { ok: false, message: 'Enter a valid PAN or VAT number.' };
      const trimmed = input.value.trim();
      return validateAgainstSchema(key, trimmed === '' ? null : trimmed);
    }
    default: {
      if (input.kind !== 'text') return { ok: false, message: 'Enter a valid value.' };
      return validateAgainstSchema(key, input.value.trim());
    }
  }
}

function parseRawStrings(key: SettingKey, raw: readonly string[]): SettingInput {
  let value: unknown;
  switch (key) {
    case 'currency.enabled':
      value = [...raw];
      break;
    case 'approvals.sla_defaults':
    case 'sales.default_schedule':
      try {
        value = JSON.parse(raw[0] ?? '') as unknown;
      } catch {
        return { ok: false, message: 'The text is not valid JSON.' };
      }
      break;
    case 'entity.pan_vat_no': {
      // The form sends an empty string for "none"; the stored value for none is null.
      const text = (raw[0] ?? '').trim();
      value = text === '' ? null : text;
      break;
    }
    case 'entity.address': {
      const text = (raw[0] ?? '').trim();
      if (text === '') {
        value = null;
        break;
      }
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, message: 'The text is not valid JSON.' };
      }
      break;
    }
    case 'fx.max_rate_age_days':
    case 'quotation.validity_days': {
      // Digits only: Number() would also take '1e1', '0x10', '7.5' and ' ', which are not day counts.
      const text = (raw[0] ?? '').trim();
      if (!WHOLE_NUMBER.test(text)) {
        return { ok: false, message: 'Enter a whole number of days, such as 7.' };
      }
      value = Number(text);
      break;
    }
    case 'procurement.min_quotes': {
      // Digits only, as for the day counts above: Number() would also take '1e1', '0x10' and '7.5'.
      const text = (raw[0] ?? '').trim();
      if (!WHOLE_NUMBER.test(text)) {
        return { ok: false, message: 'Enter a whole number of quotes, such as 3.' };
      }
      value = Number(text);
      break;
    }
    default:
      value = (raw[0] ?? '').trim();
  }
  return validateAgainstSchema(key, value);
}

function validateAgainstSchema(key: SettingKey, value: unknown): SettingInput {
  const schema: z.ZodType = SETTINGS[key];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Validates and serialises a setting value for PUT /v1/admin/settings/:key.
 * Accepts typed `SettingFieldValue` (from the SettingsForm controls) or legacy `readonly string[]`.
 */
export function parseSettingInput(
  key: SettingKey,
  input: SettingFieldValue | readonly string[],
): SettingInput {
  return isTypedValue(input) ? parseTypedField(key, input) : parseRawStrings(key, input);
}

/** True when a typed field draft parses cleanly and equals the built-in default (D32). */
export function isFieldAtDefault(key: SettingKey, draft: SettingFieldValue): boolean {
  const parsed = parseTypedField(key, draft);
  return parsed.ok && isDefaultValue(key, parsed.value);
}

/** The current value as text for display and for a prefilled field. */
export function settingValueText(value: unknown): string {
  // An unset value (the entity settings) shows as an empty field, not as the word "null".
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
  return JSON.stringify(value, null, 2);
}
