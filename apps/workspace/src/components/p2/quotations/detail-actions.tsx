import { randomUUID } from 'node:crypto';

import {
  canReviseQuotation,
  QUOTATION_REVISION_RULES,
  type QuotationContact,
  type QuotationVersionDto,
} from '@bos/contracts';

import { canRecordOutcome, kathmanduToday, preselectedContactId, sendGate } from './eligibility';
import { OutcomeDialog } from './outcome-dialog';
import { ReviseForm } from './revise-form';
import { SendDialog } from './send-dialog';

/**
 * The actions on one quotation, for the detail page's action slot: Send to customer, Record outcome
 * and Revise, each only where its rule allows. Server Component: it decides from the current
 * version, generates one Idempotency-Key per action for this render (the forms send it, and keep it
 * after an unknown outcome so a landed call cannot apply twice) and hands the dialogs plain data.
 * Returns nothing for a status with no action, so the slot stays empty.
 */
export function DetailActions({
  quotationId,
  number,
  current,
  contacts,
  reloadHref,
  today = kathmanduToday(),
}: {
  quotationId: string;
  number: string;
  /** The version the actions act on. `current.version` is the `expectedVersion` each one sends. */
  current: QuotationVersionDto;
  contacts: readonly QuotationContact[];
  reloadHref: string;
  /** `YYYY-MM-DD` in Kathmandu. A prop so a test can pin the clock. */
  today?: string;
}) {
  const { status } = current;
  const ids = { quotationId, versionId: current.id, version: current.version, number, reloadHref };

  // Send is offered for an approved quotation, and for an expired one so the reason is on screen.
  const showSend = status === 'approved' || status === 'expired';
  const gate = sendGate(current, contacts, today);

  return (
    <>
      {showSend ? (
        <SendDialog
          {...ids}
          contacts={contacts}
          defaultContactId={preselectedContactId(current.contactId, contacts)}
          idempotencyKey={randomUUID()}
          blocker={gate.ok ? null : gate.reason}
        />
      ) : null}
      {canRecordOutcome(status) ? (
        <OutcomeDialog {...ids} today={today} idempotencyKey={randomUUID()} />
      ) : null}
      {canReviseQuotation(status) ? (
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
