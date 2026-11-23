// The KYB (know your business) rules that need no database: the standard checklist, which states take
// changes, what a submit needs and what an approval needs. Pure, so each rule has a plain unit test.
// Serves the NFR "an approval rests on evidence": an approved case has every required item backed by a
// document that the virus scan passed.
import {
  CHECKLIST_ITEM_KEYS,
  VENDOR_CHECKLIST_ITEM_KEYS,
  type ChecklistItem,
  type DocumentVersionDto,
  type VerificationPartyKind,
  type VerificationStatus,
} from '@bos/contracts';

type ItemKey = ChecklistItem['key'];

const REQUIRED_KEYS: readonly ItemKey[] = [
  'registration_certificate',
  'pan_vat_certificate',
  'authorised_signatory_id',
];

const emptyItem = (key: ItemKey, required: boolean): ChecklistItem => ({
  key,
  required,
  status: 'missing' as const,
  documentId: null,
  expiresOn: null,
});

/** What a new customer case starts with: one empty item per key, the first three required. */
export const DEFAULT_CHECKLIST: readonly ChecklistItem[] = CHECKLIST_ITEM_KEYS.map((key) =>
  emptyItem(key, REQUIRED_KEYS.includes(key)),
);

// A vendor case cannot know yet whether the vendor is a company, a proprietor or foreign (that is V1's data),
// so only what every vendor owes is required: PAN, a tax clearance (it lapses each fiscal year) and bank proof.
const REQUIRED_VENDOR_KEYS: readonly ItemKey[] = ['pan_certificate', 'tax_clearance', 'bank_proof'];

/** What a new vendor case starts with: one empty item per vendor key. */
export const VENDOR_DEFAULT_CHECKLIST: readonly ChecklistItem[] = VENDOR_CHECKLIST_ITEM_KEYS.map(
  (key) => emptyItem(key, REQUIRED_VENDOR_KEYS.includes(key)),
);

/** The checklist a new case of this party kind starts with. */
export function defaultChecklistFor(kind: VerificationPartyKind): readonly ChecklistItem[] {
  return kind === 'vendor' ? VENDOR_DEFAULT_CHECKLIST : DEFAULT_CHECKLIST;
}

/** The keys a case of this party kind may hold. */
export function checklistKeysFor(kind: VerificationPartyKind): readonly ItemKey[] {
  return kind === 'vendor' ? VENDOR_CHECKLIST_ITEM_KEYS : CHECKLIST_ITEM_KEYS;
}

/** Items whose document is only valid for a period: attaching one without an expiry is refused. */
const EXPIRY_REQUIRED_KEYS: readonly ItemKey[] = ['tax_clearance'];

export const requiresExpiry = (key: ItemKey): boolean => EXPIRY_REQUIRED_KEYS.includes(key);

/** A draft takes changes, and so does a rejected case (the customer fixes what the reviewer refused). */
export function isEditable(status: VerificationStatus): boolean {
  return status === 'draft' || status === 'rejected';
}

/** The checklist with `documentId` on the item `key` (which becomes `provided`). The input is not changed. */
export function attachDocument(
  items: readonly ChecklistItem[],
  key: ItemKey,
  documentId: string,
  expiresOn: string | null,
): ChecklistItem[] {
  const next = { status: 'provided' as const, documentId, expiresOn };
  if (!items.some((i) => i.key === key)) {
    // An older or hand-made checklist without this key: the extra item is optional.
    return [...items, { key, required: false, ...next }];
  }
  return items.map((i) => (i.key === key ? { ...i, ...next } : i));
}

const hasDocument = (i: ChecklistItem): boolean =>
  (i.status === 'provided' || i.status === 'accepted') &&
  i.documentId !== null &&
  (!requiresExpiry(i.key) || i.expiresOn !== null);

/**
 * The required items that do not have a document yet (where an expiry is required, a document without one
 * counts as missing too). A case with no required item at all cannot be verified (the contract's
 * `isChecklistComplete` says the same), so it reports `no_required_item`.
 */
export function missingRequired(items: readonly ChecklistItem[]): string[] {
  const required = items.filter((i) => i.required);
  if (required.length === 0) return ['no_required_item'];
  return required.filter((i) => !hasDocument(i)).map((i) => i.key);
}

/**
 * Required and currently attached items that cannot back an approval. Check their newest
 * non-rejected version. Prior replacements and unused uploads remain in the case history.
 */
export function documentProblems(
  items: readonly ChecklistItem[],
  versions: readonly Pick<DocumentVersionDto, 'documentId' | 'version' | 'status'>[],
): string[] {
  const newest = new Map<string, Pick<DocumentVersionDto, 'documentId' | 'version' | 'status'>>();
  for (const v of versions) {
    if (v.status === 'rejected') continue;
    const seen = newest.get(v.documentId);
    if (seen === undefined || v.version > seen.version) newest.set(v.documentId, v);
  }
  return items
    .filter((i) => i.required || i.documentId !== null)
    .filter((i) => i.documentId === null || newest.get(i.documentId)?.status !== 'clean')
    .map((i) => i.key);
}

/** An approval accepts what was provided. */
export function acceptProvided(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.map((i) => (i.status === 'provided' ? { ...i, status: 'accepted' as const } : i));
}

/**
 * Reopening an expired case: an item whose document ran out on or before `today` (YYYY-MM-DD) is empty again;
 * everything else stays, so the customer only replaces what lapsed.
 */
export function reopenChecklist(items: readonly ChecklistItem[], today: string): ChecklistItem[] {
  return items.map((i) =>
    i.expiresOn !== null && i.expiresOn <= today
      ? { ...i, status: 'missing' as const, documentId: null, expiresOn: null }
      : i,
  );
}

/**
 * The documents of a case that were first uploaded before an identity change reset it (R6AE). A file is "before the
 * change" when its first version is older than `resetAt`; a later version of the same document does not make it new.
 * These stay on the case as history but cannot be put on the checklist again. A case never reset has none.
 */
export function documentsBeforeReset(
  versions: readonly Pick<DocumentVersionDto, 'documentId' | 'createdAt'>[],
  resetAt: Date | null,
): Set<string> {
  const before = new Set<string>();
  if (resetAt === null) return before;
  const first = new Map<string, number>();
  for (const v of versions) {
    const at = Date.parse(v.createdAt);
    const seen = first.get(v.documentId);
    if (seen === undefined || at < seen) first.set(v.documentId, at);
  }
  for (const [documentId, at] of first) if (at < resetAt.getTime()) before.add(documentId);
  return before;
}

/** What a person reads when they try to reuse a file from before the change. */
export const FILE_BEFORE_CHANGE_MESSAGE =
  'This file was uploaded before the details changed. Upload it again.';
