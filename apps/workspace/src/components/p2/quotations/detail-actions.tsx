import { randomUUID } from 'node:crypto';

import {
  canReviseQuotation,
  isQuotationEditable,
  QUOTATION_REVISION_RULES,
  type QuotationCapabilities,
  type QuotationContact,
  type QuotationVersionDto,
} from '@bos/contracts';

import { LinkButton } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';

import { canRecordOutcome, kathmanduToday, preselectedContactId, sendGate } from './eligibility';
import { OutcomeDialog, type OutcomeDialogProps } from './outcome-dialog';
import styles from './detail.module.css';
import { ReviseForm } from './revise-form';
import { SendDialog } from './send-dialog';

/**
 * The actions on one quotation, for the detail page's action slot: Edit, Send to customer, Record
 * outcome and Revise, each only where its rule allows. Edit and Revise also need the server's
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
}: {
  quotationId: string;
  number: string;
  /** The version the actions act on. `current.version` is the `expectedVersion` each one sends. */
  current: QuotationVersionDto;
  contacts: readonly QuotationContact[];
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
}) {
  const { status } = current;
  const ids = { quotationId, versionId: current.id, version: current.version, number, reloadHref };

  // Send is offered for an approved quotation, and for an expired one so the reason is on screen.
  const showSend =
    (status === 'approved' || status === 'expired') && (capabilities.canSend ?? maySend ?? true);
  const showOutcome =
    includeOutcome &&
    canRecordOutcome(status) &&
    (capabilities.canRecordOutcome ?? mayRecordOutcome ?? true);
  const gate = sendGate(current, contacts, today);

  // Draft and Returned are changed in place in the quote builder; every later change is a revision.
  const showEdit = capabilities.canEdit && isQuotationEditable(status);
  const showRevise = capabilities.canRevise && canReviseQuotation(status);

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
          {...ids}
          contacts={contacts}
          defaultContactId={preselectedContactId(current.contactId, contacts)}
          idempotencyKey={randomUUID()}
          blocker={gate.ok ? null : gate.reason}
        />
      ) : null}
      {showOutcome ? <OutcomeDialog {...ids} today={today} idempotencyKey={randomUUID()} /> : null}
      {showRevise ? (
        <ReviseForm
          {...ids}
          supersedes={(QUOTATION_REVISION_RULES.supersededOnRevise as readonly string[]).includes(
            status,
          )}
          idempotencyKey={randomUUID()}
        />
      ) : null}
    </>
  );
}

export function ClientDecision({
  current,
  ...quotation
}: Pick<OutcomeDialogProps, 'quotationId' | 'number' | 'reloadHref'> & {
  current: QuotationVersionDto;
}) {
  if (!canRecordOutcome(current.status)) return null;
  return (
    <Panel
      title="Record client decision"
      className={styles.detailPanel}
      description="Record whether the customer accepted or declined this quotation."
    >
      <div className={styles.actions}>
        <OutcomeDialog
          {...quotation}
          versionId={current.id}
          version={current.version}
          today={kathmanduToday()}
          idempotencyKey={randomUUID()}
        />
      </div>
    </Panel>
  );
}
