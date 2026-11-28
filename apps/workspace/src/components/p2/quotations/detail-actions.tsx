import { randomUUID } from 'node:crypto';

import {
  canReviseQuotation,
  isQuotationEditable,
  QUOTATION_REVISION_RULES,
  type QuotationCapabilities,
  type QuotationContact,
  type QuotationStatus,
  type QuotationVersionDto,
} from '@bos/contracts';

import { LinkButton } from '@/components/ui/button';

import { CancelDialog } from './cancel-dialog';
import { canRecordOutcome, kathmanduToday, preselectedContactId, sendGate } from './eligibility';
import { mayCancel } from './lifecycle-contract';
import { opportunityBlockers, type OpportunityFacts } from './opportunity-gate';
import { OutcomeDialog } from './outcome-dialog';
import { ReviseForm } from './revise-form';
import { SendDialog } from './send-dialog';
import type { ContactCreate } from '../customers/contact-picker';

export interface DetailActionVisibility {
  status: QuotationStatus;
  capabilities: QuotationCapabilities;
  includeOutcome?: boolean;
  maySend?: boolean;
  mayRecordOutcome?: boolean;
  /**
   * The quotation's opportunity, for the stage rules Send and Accepted depend on. Null when it could
   * not be read: then nothing is held back here and the API decides.
   */
  opportunity?: OpportunityFacts | null;
  /** The current version's id, which an opportunity already Won may name. */
  versionId?: string;
}

/** Whether `DetailActions` will render at least one button for this quotation and caller. */
export function hasDetailActions({
  status,
  capabilities,
  includeOutcome = true,
  maySend,
  mayRecordOutcome,
  opportunity,
  versionId = '',
}: DetailActionVisibility): boolean {
  const blockers = opportunityBlockers(opportunity, versionId);
  const showSend =
    (status === 'approved' || status === 'expired') &&
    blockers.send === null &&
    (capabilities.canSend ?? maySend ?? false);
  const showOutcome =
    includeOutcome &&
    canRecordOutcome(status) &&
    (capabilities.canRecordOutcome ?? mayRecordOutcome ?? false);
  const showEdit = capabilities.canEdit && isQuotationEditable(status);
  const showRevise = capabilities.canRevise && canReviseQuotation(status);
  const showCancel = mayCancel(status, capabilities);
  return showEdit || showSend || showOutcome || showRevise || showCancel;
}

/**
 * The actions on one quotation, for the detail page's action slot: Edit, Send to customer, Record
 * outcome, Revise and Cancel quotation, each only where its rule allows. Edit and Revise also need the server's
 * record-level answer (`capabilities`), so a caller who would get 403 is never offered them.
 * Server Component: it decides from the current version, generates one Idempotency-Key per action
 * for this render (the forms send it, and keep it after an unknown outcome so a landed call cannot
 * apply twice) and hands the dialogs plain data. Returns nothing for a status with no action, so
 * the slot stays empty.
 */
export function DetailActions({
  quotationId,
  number,
  current,
  contacts,
  capabilities,
  reloadHref,
  today = kathmanduToday(),
  includeOutcome = true,
  maySend,
  mayRecordOutcome,
  opportunity,
  createContact,
}: {
  quotationId: string;
  number: string;
  /** The version the actions act on. `current.version` is the `expectedVersion` each one sends. */
  current: QuotationVersionDto;
  contacts: readonly QuotationContact[];
  /** Lets the Send dialog's contact picker add a contact to the customer; null or missing when the caller may not. */
  createContact?: ContactCreate | null;
  /** What the server says this caller may do with this quotation now. */
  capabilities: QuotationCapabilities;
  reloadHref: string;
  /** `YYYY-MM-DD` in Kathmandu. A prop so a test can pin the clock. */
  today?: string;
  includeOutcome?: boolean;
  /** Live permission fallback when `capabilities.canSend` is omitted. */
  maySend?: boolean;
  /** Live permission fallback when `capabilities.canRecordOutcome` is omitted. */
  mayRecordOutcome?: boolean;
  /** The quotation's opportunity; null when it could not be read (then the API decides). */
  opportunity?: OpportunityFacts | null;
}) {
  const { status } = current;
  const ids = { quotationId, versionId: current.id, version: current.version, number, reloadHref };
  // The dialogs refresh the page instead of reloading it, so each is keyed on the version it expects: after an action the
  // new version remounts the form, and the old expected version cannot be sent again (a 409).
  const versionKey = `${current.id}:${current.version}`;

  // Send is offered for an approved quotation, and for an expired one so the reason is on screen.
  // An opportunity the API would refuse to move hides it; the page says why (opportunity-gate.ts).
  const blockers = opportunityBlockers(opportunity, current.id);
  const showSend =
    (status === 'approved' || status === 'expired') &&
    blockers.send === null &&
    (capabilities.canSend ?? maySend ?? false);
  const showOutcome =
    includeOutcome &&
    canRecordOutcome(status) &&
    (capabilities.canRecordOutcome ?? mayRecordOutcome ?? false);
  const gate = sendGate(current, contacts, today);

  // Draft and Returned are changed in place in the quote builder; every later change is a revision.
  const showEdit = capabilities.canEdit && isQuotationEditable(status);
  const showRevise = capabilities.canRevise && canReviseQuotation(status);
  const showCancel = mayCancel(status, capabilities);

  return (
    <>
      {showEdit ? (
        <LinkButton
          href={`/quotations/${encodeURIComponent(quotationId)}/edit`}
          aria-label={`Edit ${number}`}
        >
          Edit
        </LinkButton>
      ) : null}
      {showSend ? (
        <SendDialog
          key={versionKey}
          {...ids}
          contacts={contacts}
          createContact={createContact ?? null}
          defaultContactId={preselectedContactId(current.contactId, contacts)}
          idempotencyKey={randomUUID()}
          blocker={gate.ok ? null : gate.reason}
        />
      ) : null}
      {showOutcome ? (
        <OutcomeDialog
          key={versionKey}
          {...ids}
          revisionNo={current.revisionNo}
          today={today}
          acceptBlocker={blockers.accept}
          idempotencyKey={randomUUID()}
        />
      ) : null}
      {showRevise ? (
        <ReviseForm
          key={versionKey}
          {...ids}
          supersedes={(QUOTATION_REVISION_RULES.supersededOnRevise as readonly string[]).includes(
            status,
          )}
          idempotencyKey={randomUUID()}
        />
      ) : null}
      {showCancel ? (
        <CancelDialog
          key={versionKey}
          {...ids}
          awaitingApproval={status === 'submitted'}
          isRevision={(current.supersedesVersionId ?? null) !== null}
          revisionNo={current.revisionNo}
          idempotencyKey={randomUUID()}
        />
      ) : null}
    </>
  );
}
