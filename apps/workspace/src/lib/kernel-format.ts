// Display helpers for Server Components that need @bos/locale or contract constants (kept out of
// kernel-ui.ts so Client Components do not pull in decimal.js and the Nepali calendar).
// Serves the NFR "amounts are exact and dates are Kathmandu time" for every kernel screen.
import { DEFAULT_ROLE_PERMISSIONS, richTextToPlain } from '@bos/contracts';
import { formatKathmandu, formatMoney, type NumberSystems } from '@bos/locale';

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

/**
 * Money for display, or the raw text when it is not a decimal (never throws on odd data).
 * `numberSystems` is the tenant's grouping setting (`getNumberSystems()` on the server); left out,
 * each currency keeps its own grouping.
 */
export function money(
  amount: string,
  currency: Currency = 'NPR',
  numberSystems?: NumberSystems,
): string {
  return DECIMAL.test(amount)
    ? formatMoney(amount, currency, numberSystems === undefined ? undefined : { numberSystems })
    : amount;
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

/** No value to show: nothing, blank text, or a container with nothing in it (`[]`, `{}`). */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

const referenceKeys = new Set([
  'ownerUserId',
  'customerPartyId',
  'customerId',
  'contactId',
  'organizationId',
  'documentId',
  'versionId',
  'documentVersionId',
  'quotationId',
  'quotationVersionId',
  'invoiceId',
  'salesOrderId',
  'paymentTermId',
  'taxCodeId',
  'catalogItemId',
  'requesterUserId',
  'actorUserId',
  'groupId',
  'userId',
]);

/** Display technical references without exposing opaque keys, including nested frozen records. */
function snapshotValue(value: unknown, references: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => snapshotValue(item, references));
  if (typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    return references.get(value) ?? 'Name unavailable';
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (
        referenceKeys.has(key) ||
        (key === 'id' && typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(raw))
      ) {
        return [
          key.replace(/(?:Ids?|_ids?)$/, '') || 'reference',
          raw == null
            ? 'Not assigned'
            : typeof raw === 'string'
              ? (references.get(raw) ?? 'Name unavailable')
              : 'Name unavailable',
        ];
      }
      return [key, snapshotValue(raw, references)];
    }),
  );
}

/**
 * Snapshot keys that hold terms wording, which is stored as rich text (D31). The frozen value (and
 * so the approval hash) stays as saved; the row shows its words, never the markup.
 */
const richTextKeys: ReadonlySet<string> = new Set([
  'scope',
  'assumptions',
  'exclusions',
  'deliveryTimeline',
  'termsAndConditions',
  'terms',
]);

/**
 * Turns the frozen snapshot (an unknown JSON value) into labelled rows. The snapshot is exactly
 * what the approvers saw: business values are preserved and money and dates are formatted.
 * Technical references use unavailable-name labels; the stored snapshot remains unchanged.
 */
export function snapshotEntries(
  snapshot: unknown,
  references: ReadonlyMap<string, string> = new Map(),
  numberSystems?: NumberSystems,
): SnapshotEntry[] {
  if (isEmptyValue(snapshot)) return [];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return [
      {
        key: 'value',
        label: 'Value',
        value: JSON.stringify(snapshotValue(snapshot, references), null, 2),
        block: true,
      },
    ];
  }
  const record = snapshotValue(snapshot, references) as Record<string, unknown>;
  const currency = asCurrency(record['currency']);
  return Object.entries(record)
    .filter(([, raw]) => !isEmptyValue(raw))
    .filter(
      ([key, raw]) =>
        !(richTextKeys.has(key) && typeof raw === 'string' && richTextToPlain(raw).trim() === ''),
    )
    .map(([key, raw]): SnapshotEntry => {
      const label = humanizeKey(key);
      if (typeof raw === 'string') {
        if (/Npr$/.test(key) && DECIMAL.test(raw)) {
          return { key, label, value: money(raw, 'NPR', numberSystems), block: false };
        }
        if (key === 'amount' && currency !== null && DECIMAL.test(raw)) {
          return { key, label, value: money(raw, currency, numberSystems), block: false };
        }
        if (ISO_INSTANT.test(raw)) return { key, label, value: when(raw), block: false };
        if (richTextKeys.has(key)) {
          const words = richTextToPlain(raw);
          return { key, label, value: words, block: words.includes('\n') || words.length > 120 };
        }
        return { key, label, value: raw, block: raw.includes('\n') || raw.length > 120 };
      }
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { key, label, value: String(raw), block: false };
      }
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
