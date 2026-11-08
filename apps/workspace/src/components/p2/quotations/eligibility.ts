// What the actions on a quotation may do, decided as pure data. Type-only imports from the contracts
// and no `@bos/locale`, so the client dialogs can import this file without pulling in decimal.js or
// the Nepali calendar. Serves the NFR "deny by default": Send is enabled only when every condition
// is proven, and every other case comes back as a sentence the person can read.
import type {
  DocumentVersionStatus,
  EvidenceKind,
  QuotationContact,
  QuotationStatus,
} from '@bos/contracts';

const KATHMANDU_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kathmandu',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in Kathmandu as `YYYY-MM-DD`, whatever time zone the server runs in. */
export function kathmanduToday(now: Date = new Date()): string {
  const parts = KATHMANDU_DAY.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Plain labels for the kinds of evidence. A full record: a new contract kind fails to compile here. */
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  signed_quote: 'Signed quotation',
  purchase_order: 'Purchase order',
  contract: 'Contract',
};

/** The order the checkboxes appear in: the default policy asks for a signed quote first. */
export const EVIDENCE_ORDER: readonly EvidenceKind[] = [
  'signed_quote',
  'purchase_order',
  'contract',
];

/** A contact the quotation can be sent to: it has an email address that is not blank. */
export function hasEmail(contact: Pick<QuotationContact, 'email'>): boolean {
  return contact.email !== null && contact.email.trim() !== '';
}

export function eligibleContacts<T extends Pick<QuotationContact, 'email'>>(
  contacts: readonly T[],
): T[] {
  return contacts.filter(hasEmail);
}

/**
 * The recipient the Send dialog starts on: the version's own contact when it can receive email,
 * otherwise nobody (the person chooses). Never an ineligible contact, never a guess.
 */
export function preselectedContactId(
  contactId: string | null,
  contacts: readonly Pick<QuotationContact, 'id' | 'email'>[],
): string {
  const match = contactId === null ? undefined : contacts.find((c) => c.id === contactId);
  return match !== undefined && hasEmail(match) ? match.id : '';
}

export interface SendGateInput {
  status: QuotationStatus;
  renderedScanStatus: DocumentVersionStatus | null;
  /** `YYYY-MM-DD`. */
  validUntil: string;
}

/** Past its validity date: strictly before today, so the last valid day still counts. */
export function isExpired(
  version: Pick<SendGateInput, 'status' | 'validUntil'>,
  today: string,
): boolean {
  return version.status === 'expired' || version.validUntil < today;
}

export type SendGate = { ok: true } | { ok: false; reason: string };

function fileBlocker(scan: DocumentVersionStatus | null): string {
  if (scan === null || scan === 'awaiting_content')
    return 'The customer PDF is still being prepared. Send is available once it is ready.';
  if (scan === 'quarantined')
    return 'The customer PDF is still being scanned. Send is available once the scan is clean.';
  // Infected, rejected and failed scans: the screen never says why, only that it cannot go out.
  return 'The customer PDF is not available, so this quotation cannot be sent.';
}

/**
 * Whether the quotation may be sent now. One reason at a time, the first that applies: expired,
 * not approved, file not clean, nobody to send it to. Enabled only when all hold.
 */
export function sendGate(
  version: SendGateInput,
  contacts: readonly Pick<QuotationContact, 'email'>[],
  today: string,
): SendGate {
  if (isExpired(version, today))
    return { ok: false, reason: 'This quotation has expired. Revise it to send an updated one.' };
  if (version.status !== 'approved')
    return { ok: false, reason: 'Only an approved quotation can be sent.' };
  if (version.renderedScanStatus !== 'clean') {
    return { ok: false, reason: fileBlocker(version.renderedScanStatus) };
  }
  if (eligibleContacts(contacts).length === 0) {
    return {
      ok: false,
      reason: 'No contact for this customer has an email address. Add one, then reload.',
    };
  }
  return { ok: true };
}

/** An outcome can be recorded only on a version that went out to the customer. */
export function canRecordOutcome(status: QuotationStatus): boolean {
  return status === 'sent';
}
