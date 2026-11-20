import { randomUUID } from 'node:crypto';

import type { InvoiceDto } from '@bos/contracts';

import { kindMeta } from '../_lib/meta';
import type { InvoiceGates } from '../_lib/gates';

import {
  DiscardDialog,
  IssueBlocked,
  IssueDialog,
  ReopenDialog,
  SubmitDialog,
} from './action-forms';

/**
 * The actions on one invoice, for the detail page's action slot: Submit for approval, Issue and
 * Discard, each only where `invoiceGates` allows it. Server Component: it generates one
 * Idempotency-Key per action for this render (the forms send it, and keep it after an unknown
 * outcome so a landed call cannot apply twice) and hands the dialogs plain data. Returns nothing
 * when no action applies, so the slot stays empty.
 */
export function InvoiceActions({
  invoice,
  gates,
  reloadHref,
}: {
  invoice: Pick<InvoiceDto, 'id' | 'kind' | 'status' | 'number' | 'version'>;
  gates: InvoiceGates;
  reloadHref: string;
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
      {gates.reopen ? <ReopenDialog {...ids} idempotencyKey={randomUUID()} /> : null}
      {gates.discard ? <DiscardDialog {...ids} idempotencyKey={randomUUID()} /> : null}
    </>
  );
}
