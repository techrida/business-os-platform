// Display helpers for Server Components that need @bos/locale or contract constants (kept out of
// kernel-ui.ts so Client Components do not pull in decimal.js and the Nepali calendar).
// Serves the NFR "amounts are exact and dates are Kathmandu time" for every kernel screen.
import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { formatKathmandu, formatMoney } from '@bos/locale';

import { humanizeKey } from './kernel-ui';

const CURRENCIES = ['NPR', 'INR', 'USD'] as const;
type Currency = (typeof CURRENCIES)[number];

function asCurrency(value: unknown): Currency | null {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
    ? (value as Currency)
    : null;
}

const DECIMAL = /^-?\d{1,16}(\.\d{1,2})?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Money for display, or the raw text when it is not a decimal (never throws on odd data). */
export function money(amount: string, currency: Currency = 'NPR'): string {
  return DECIMAL.test(amount) ? formatMoney(amount, currency) : amount;
}

/** `17 Jul 2025, 05:45` in Kathmandu time, or the raw text when it is not a date. */
export function when(iso: string, style: 'date' | 'datetime' = 'datetime'): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatKathmandu(d, style);
}

export interface SnapshotEntry {
  key: string;
  label: string;
  /** Short values render as text. Long or nested data renders as a block. */
  value: string;
  block: boolean;
}

/** Internal references are retained in the snapshot, but are not product display values. */
function snapshotForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotForDisplay);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'id' && !/Ids?$/.test(key))
        .map(([key, item]) => [key, snapshotForDisplay(item)]),
    );
  }
  if (typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    return 'Reference unavailable';
  }
  return value;
}

/**
 * Turns the frozen snapshot (an unknown JSON value) into labelled rows. The snapshot is exactly
 * what the approvers saw, with internal references omitted from display. Money-looking and date-looking values are
 * formatted; business facts remain as stored.
 */
export function snapshotEntries(snapshot: unknown): SnapshotEntry[] {
  snapshot = snapshotForDisplay(snapshot);
  if (snapshot === undefined || snapshot === null) return [];
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return [
      { key: 'value', label: 'Value', value: JSON.stringify(snapshot, null, 2), block: true },
    ];
  }
  const record = snapshot as Record<string, unknown>;
  const currency = asCurrency(record['currency']);
  return Object.entries(record).map(([key, raw]): SnapshotEntry => {
    const label = humanizeKey(key);
    if (typeof raw === 'string') {
      if (/Npr$/.test(key) && DECIMAL.test(raw)) {
        return { key, label, value: money(raw, 'NPR'), block: false };
      }
      if (key === 'amount' && currency !== null && DECIMAL.test(raw)) {
        return { key, label, value: money(raw, currency), block: false };
      }
      if (ISO_INSTANT.test(raw)) return { key, label, value: when(raw), block: false };
      return { key, label, value: raw, block: raw.includes('\n') || raw.length > 120 };
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      return { key, label, value: String(raw), block: false };
    }
    if (raw === null || raw === undefined) return { key, label, value: 'None', block: false };
    return { key, label, value: JSON.stringify(raw, null, 2), block: true };
  });
}

/**
 * Whether the nav shows Admin. `session.roles` holds role keys, not permissions, so this reads the
 * default grants: any role whose defaults include an `admin.*` permission. A custom grant added
 * later in the admin screens does not show here; the admin pages and the API still enforce it.
 */
export function canSeeAdmin(roles: readonly string[]): boolean {
  return roles.some((role) => {
    const grants = (DEFAULT_ROLE_PERMISSIONS as Record<string, object | undefined>)[role] as
      Record<string, unknown> | undefined;
    return grants !== undefined && Object.keys(grants).some((p) => p.startsWith('admin.'));
  });
}
