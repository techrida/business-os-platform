// Turns what a settings form submitted into a value for PUT /v1/admin/settings/:key. Serves the NFR
// "configuration changes are versioned": the value is checked against the shared SETTINGS schema
// here, so the admin sees the problem next to the field; the API checks it again and is the authority.
import { SETTINGS, type SettingKey } from '@bos/contracts';
import type { z } from 'zod';

export type SettingInput = { ok: true; value: unknown } | { ok: false; message: string };

/** `raw` holds every submitted value for the field: one entry, or one per ticked checkbox. */
export function parseSettingInput(key: SettingKey, raw: readonly string[]): SettingInput {
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
      if (!/^[0-9]+$/.test(text)) {
        return { ok: false, message: 'Enter a whole number of days, such as 7.' };
      }
      value = Number(text);
      break;
    }
    case 'procurement.min_quotes': {
      // Digits only, as for the day counts above: Number() would also take '1e1', '0x10' and '7.5'.
      const text = (raw[0] ?? '').trim();
      if (!/^[0-9]+$/.test(text)) {
        return { ok: false, message: 'Enter a whole number of quotes, such as 3.' };
      }
      value = Number(text);
      break;
    }
    default:
      value = (raw[0] ?? '').trim();
  }
  const schema: z.ZodType = SETTINGS[key];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: parsed.data };
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
