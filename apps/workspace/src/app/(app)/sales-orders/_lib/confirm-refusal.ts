// Plain words for confirming a draft sales order (F1-Q25, F1-Q28): why the page cannot offer Confirm yet
// (`draft.blocker`), and the refusals of `POST /v1/sales-orders` that the general billing words do not name.
// Pure, so the page, the server action and the tests share it.
import type { SalesOrderDraftState } from '@bos/contracts';

import { evidenceKindLabel } from './status';

type Kind = SalesOrderDraftState['missing'][number];

function list(kinds: readonly Kind[]): string {
  const words = kinds.map((k) => evidenceKindLabel(k).toLowerCase());
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Why a draft order cannot be confirmed yet, or null when nothing blocks it. */
export function draftBlockerText(draft: SalesOrderDraftState | null | undefined): string | null {
  switch (draft?.blocker) {
    case 'evidence_not_confirmed':
      return 'It cannot be confirmed yet. The customer accepted in the portal, and a staff member has to confirm their evidence on the quotation first.';
    case 'evidence_policy_unmet':
      return draft.missing.length > 0
        ? `It cannot be confirmed yet. Your company's evidence policy also needs the ${list(draft.missing)}.`
        : "It cannot be confirmed yet. The evidence does not meet your company's evidence policy.";
    default:
      return null;
  }
}

/** The API's error code from a failed call's body, or ''. */
export function codeOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return '';
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** Words for a refusal to confirm an order, or undefined to use the general billing words. */
export function confirmRefusalText(err: unknown): string | undefined {
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : 0;
  const code = codeOf(err);
  if (status === 422 && code === 'evidence_not_confirmed') {
    return "This order cannot be confirmed yet: the customer's evidence for the accepted quotation has not been confirmed. Confirm it on the quotation, or ask the sales team to, then try again. Nothing was confirmed.";
  }
  if (status === 422 && code === 'invalid_evidence_document') {
    // The general evidence words say "this record": here the file belongs to the chosen quotation.
    // An infected file (409 `document_infected`) keeps the general infected-file words.
    return 'That file is not evidence uploaded for this quotation, or it has not finished uploading. Remove it, upload it again, then confirm. Nothing was confirmed.';
  }
  if (status === 409 && code === 'draft_of_other_revision') {
    return 'A draft order from another revision of this quotation is already waiting. Open that draft from the sales orders list instead. Nothing was confirmed.';
  }
  if (status === 409 && code === 'evidence_not_filed') {
    // Someone confirmed the order first (another tab or person): the confirm did not run again, so the
    // file named with it stays unfiled. Never "Order confirmed": this click confirmed nothing.
    return 'This order was already confirmed, so your file was not filed with it. Open the order from the sales orders list; you can add evidence when you mark a billing step billable.';
  }
  return undefined;
}
