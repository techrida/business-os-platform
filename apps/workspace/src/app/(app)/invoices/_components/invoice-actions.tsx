import { randomUUID } from 'node:crypto';

import type { InvoiceDto } from '@bos/contracts';
import { DEFAULT_CUSTOMER_DATE_FORMAT, type CustomerDateFormat } from '@bos/locale';

import { kindMeta } from '../_lib/meta';
import type { InvoiceGates } from '../_lib/gates';

import {
  DiscardDialog,
  EditDueDateBlocked,
  EditDueDateDialog,
  IssueBlocked,
  IssueDialog,
  ReopenDialog,
  type ReopenedDueDate,
  SubmitDialog,
} from './action-forms';
import { documentDate } from './document/format';

/** The due-date route's kind rule, for the Back to draft words only; the API's `can.editDueDate` decides the button. */
function reopenedDueDate(invoice: Pick<InvoiceDto, 'kind' | 'salesOrderId'>): ReopenedDueDate {
  if (invoice.kind === 'credit_note') return 'none';
  if (invoice.kind === 'debit_note' || invoice.salesOrderId !== null) return 'set_at_issue';
  return 'editable';
}

/** A due date as the page writes it: AD in the display pattern, then its BS form when the converter has one. */
function dueDateText(iso: string | null, pattern: CustomerDateFormat): string | null {
  if (iso === null) return null;
  const { ad, bs } = documentDate(iso, null, pattern);
  return bs === null ? ad : `${ad} (${bs})`;
}

/**
 * The actions on one invoice, for the detail page's action slot: Submit for approval, Issue, Edit due
 * date, Back to draft and Discard, each only where `invoiceGates` allows it. Server Component: it generates one
 * Idempotency-Key per action for this render (the forms send it, and keep it after an unknown
 * outcome so a landed call cannot apply twice) and hands the dialogs plain data. Returns nothing
 * when no action applies, so the slot stays empty.
 */
export function InvoiceActions({
  invoice,
  gates,
  reloadHref,
  dateFormat = DEFAULT_CUSTOMER_DATE_FORMAT,
}: {
  invoice: Pick<
    InvoiceDto,
    'id' | 'kind' | 'status' | 'number' | 'version' | 'dueDate' | 'salesOrderId'
  >;
  gates: InvoiceGates;
  reloadHref: string;
  /** The page's date pattern for the due date in the dialog; the default pattern when left out. */
  dateFormat?: CustomerDateFormat;
}) {
  const kindLabel = kindMeta(invoice.kind).label;
  const ids = {
    invoiceId: invoice.id,
    // `invoice.version` is the `expectedVersion` each action sends.
    version: invoice.version,
    name: invoice.number ?? kindLabel.toLowerCase(),
    reloadHref,
  };
  return (
    <>
      {gates.submit ? <SubmitDialog {...ids} idempotencyKey={randomUUID()} /> : null}
      {gates.issue && gates.issueBlocker !== null ? (
        <IssueBlocked kindLabel={kindLabel} reason={gates.issueBlocker} />
      ) : gates.issue ? (
        <IssueDialog {...ids} kindLabel={kindLabel} idempotencyKey={randomUUID()} />
      ) : null}
      {gates.editDueDate === null ? null : gates.editDueDate.reason !== null ? (
        <EditDueDateBlocked reason={gates.editDueDate.reason} />
      ) : (
        <EditDueDateDialog
          {...ids}
          dueDate={invoice.dueDate}
          dueDateText={dueDateText(invoice.dueDate, dateFormat)}
          idempotencyKey={randomUUID()}
        />
      )}
      {gates.reopen ? (
        <ReopenDialog {...ids} dueDate={reopenedDueDate(invoice)} idempotencyKey={randomUUID()} />
      ) : null}
      {gates.discard ? <DiscardDialog {...ids} idempotencyKey={randomUUID()} /> : null}
    </>
  );
}
