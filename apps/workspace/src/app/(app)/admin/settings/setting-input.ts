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
      try {
        value = JSON.parse(raw[0] ?? '') as unknown;
      } catch {
        return { ok: false, message: 'The text is not valid JSON.' };
      }
      break;
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
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
  return JSON.stringify(value, null, 2);
}
