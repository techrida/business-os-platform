// Is a saved setting still at its default? (D32: a changed setting shows an undo icon.) A plain
// module, not part of the 'use client' button file: Server Components call these, and a function
// exported from a client file is only a reference on the server.
import { SETTINGS, SETTING_DEFAULTS, type SettingKey } from '@bos/contracts';
import type { z } from 'zod';

/** Keys whose list is a set: the order the boxes were ticked in is not a change of behaviour. */
const UNORDERED: ReadonlySet<SettingKey> = new Set<SettingKey>(['currency.enabled']);

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** '13', '13.0' and '13.00' are the same amount; the schema accepts all three. */
function normaliseDecimal(text: string): string {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  const body = decimals === '' ? digits : `${digits}.${decimals}`;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Key-sorted JSON, so object key order never decides the answer. */
function canonical(value: unknown, sortArray: boolean): string {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string' && DECIMAL.test(node)) return normaliseDecimal(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  const walked = walk(value);
  const ordered =
    sortArray && Array.isArray(walked)
      ? [...(walked as unknown[])].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )
      : walked;
  return JSON.stringify(ordered);
}

/** The value as the shared schema reads it (it fills in defaults); a value it refuses is kept as it is. */
function normalised(key: SettingKey, value: unknown): unknown {
  const schema: z.ZodType = SETTINGS[key];
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/**
 * True when `saved` equals the setting's default. Both sides go through the setting's schema, then
 * compare as key-sorted JSON, so `{ b, a }` equals `{ a, b }` and `'13.00'` equals `'13'`. Lists keep
 * their order (a billing schedule is ordered) except `currency.enabled`, which is a set. A saved
 * value the schema refuses is never the default.
 */
export function isDefaultValue(key: SettingKey, saved: unknown): boolean {
  const schema: z.ZodType = SETTINGS[key];
  if (!schema.safeParse(saved).success) return false;
  const sorted = UNORDERED.has(key);
  return (
    canonical(normalised(key, saved), sorted) ===
    canonical(normalised(key, SETTING_DEFAULTS[key]), sorted)
  );
}

const MAX_TEXT = 90;

const shorten = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text;

function describe(key: SettingKey, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value === '' ? 'empty' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (key === 'approvals.sla_defaults' && typeof value === 'object') {
    const sla = value as {
      remindAfterHours?: number;
      escalateAfterHours?: number;
      escalateTo?: { role?: string };
    };
    return `remind after ${sla.remindAfterHours} h, escalate after ${sla.escalateAfterHours} h to ${sla.escalateTo?.role}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.join(', ');
    // Slices and presets carry their own label.
    if (
      value.every(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { label?: unknown }).label === 'string',
      )
    ) {
      return value.map((v) => (v as { label: string }).label).join(', ');
    }
  }
  return JSON.stringify(value);
}

/**
 * The default as short text for the tooltip: `13`, `NPR, INR, USD`, the labels of a schedule, the
 * hours of a reminder. A screen whose default reads better in its own words (an option label) passes
 * its own text to the button instead.
 */
export function defaultText(key: SettingKey): string {
  return shorten(describe(key, SETTING_DEFAULTS[key]));
}
