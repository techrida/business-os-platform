// Display helpers for Server Components that need @bos/locale or contract constants (kept out of
// kernel-ui.ts so Client Components do not pull in decimal.js and the Nepali calendar).
// Serves the NFR "amounts are exact and dates are Kathmandu time" for every kernel screen.
import { DEFAULT_ROLE_PERMISSIONS, richTextToPlain } from '@bos/contracts';
import {
  formatCustomerDate,
  formatKathmandu,
  formatMoney,
  kathmanduDate,
  type CustomerDateFormat,
  type NumberSystems,
} from '@bos/locale';

import { documentTypeLabel } from '@/app/(app)/inbox/inbox-params';
import { isLiveGrants, type PermissionSource } from '@/components/p2/customers/permissions';

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

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const kathmanduClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kathmandu',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * `17 Jul 2025, 05:45` in Kathmandu time, or the raw text when it is not a date.
 *
 * `pattern` is the tenant's `format.date` (`getDateFormat()` on the server). With it, a YYYY-MM-DD
 * calendar date is written in that pattern as it is (no time, whatever the style), and an instant
 * is written as its Kathmandu calendar day in that pattern, plus `, HH:mm` for 'datetime'.
 */
export function when(
  iso: string,
  style: 'date' | 'datetime' = 'datetime',
  pattern?: CustomerDateFormat,
): string {
  if (pattern !== undefined && CALENDAR_DATE.test(iso)) return formatCustomerDate(iso, pattern);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (pattern === undefined) return formatKathmandu(d, style);
  const { y, m, d: day } = kathmanduDate(d);
  const date = formatCustomerDate(
    `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    pattern,
  );
  return style === 'date' ? date : `${date}, ${kathmanduClock.format(d)}`;
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

/**
 * What the approvals engine stores as the number of a document that has none yet (it is numbered at
 * issue): `Draft <document type> <first 8 characters of its id>`.
 */
export const DRAFT_REFERENCE_SOURCE = String.raw`Draft ([a-z][a-z0-9_]*) [0-9a-f]{8}`;
const DRAFT_REFERENCE = new RegExp(`^${DRAFT_REFERENCE_SOURCE}$`);

const isInternalType = (type: string) => documentTypeLabel(type) !== type || type.includes('_');

/** The words for a document type key: `Debit note`, or the humanized key for a type with no label. */
export function documentTypeWords(type: string): string {
  const known = documentTypeLabel(type);
  return known === type ? humanizeKey(type) : known;
}

/**
 * A request's document number for display: a draft reference reads `Draft debit note`, without the
 * internal type key or id. A real number is shown as it is; the stored value is not changed.
 */
export function documentNumberText(documentNumber: string): string {
  const match = DRAFT_REFERENCE.exec(documentNumber);
  // Only an internal document type key counts (a labelled type, or a key with an underscore): words a person
  // typed, such as the memo subject `Draft budget 20261120`, are left as they are.
  if (match === null || !isInternalType(match[1]!)) return documentNumber;
  const label = documentTypeWords(match[1]!);
  // Lower only a capitalised word: `Debit note` -> `debit note`, but `PR commitment` stays.
  return `Draft ${/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label}`;
}

/** Snapshot keys that are integrity data for the system, never shown to people (a 64-hex SHA-256). */
const isHashEntry = (key: string, raw: unknown) =>
  /sha256$/i.test(key) && typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw);

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
    return references.get(value.toLowerCase()) ?? 'Name unavailable';
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
              ? (references.get(raw.toLowerCase()) ?? 'Name unavailable')
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
    .filter(([key, raw]) => !isEmptyValue(raw) && !isHashEntry(key, raw))
    .filter(
      ([key, raw]) =>
        !(richTextKeys.has(key) && typeof raw === 'string' && richTextToPlain(raw).trim() === ''),
    )
    .map(([key, raw]): SnapshotEntry => {
      const label = humanizeKey(key);
      if (typeof raw === 'string') {
        if (key === 'kind' && documentTypeLabel(raw) !== raw) {
          return { key, label: 'Document type', value: documentTypeLabel(raw), block: false };
        }
        // Only the generated `reference` field: the same words typed into a reason or a subject stay as typed.
        if (key === 'reference' && documentNumberText(raw) !== raw) {
          return { key, label, value: documentNumberText(raw), block: false };
        }
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
 * Whether the nav shows Admin: the person holds any `admin.*` permission. Pass the live grants
 * (`grantsFrom` over `getMeOrNull`) so a grant added or removed in Settings > Access shows at once.
 * Role keys still read the built-in defaults, which miss those edits. The admin pages and the API
 * still enforce every request.
 */
export function canSeeAdmin(source: PermissionSource): boolean {
  if (isLiveGrants(source)) return [...source.keys()].some((p) => p.startsWith('admin.'));
  return source.some((role) => {
    const grants = (DEFAULT_ROLE_PERMISSIONS as Record<string, object | undefined>)[role] as
      Record<string, unknown> | undefined;
    return grants !== undefined && Object.keys(grants).some((p) => p.startsWith('admin.'));
  });
}
