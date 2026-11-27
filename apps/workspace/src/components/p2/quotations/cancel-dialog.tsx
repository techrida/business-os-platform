'use client';

import { useActionState, useId, useRef, useState } from 'react';

import { cancelAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { Field, Textarea } from '@/components/ui/field';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';

export interface CancelDialogProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  /** The version is waiting for approval: cancelling it also ends that approval request. */
  awaitingApproval?: boolean | undefined;
  /** This version is a revision: cancelling it gives a sent or approved earlier revision back (R6D). */
  isRevision?: boolean | undefined;
  /** The revision number, for the title of a revision's dialog. */
  revisionNo?: number | undefined;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Cancel quotation (F1-Q27): ends a Draft, Returned or Submitted quotation for good, with a mandatory reason that
 * stays on the record. Named "Cancel quotation", never "Cancel", which every dialog uses to mean "close".
 */
export function CancelDialog({
  number,
  awaitingApproval = false,
  isRevision = false,
  revisionNo,
  quotationId,
  versionId,
  version,
  idempotencyKey,
  reloadHref,
}: CancelDialogProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(cancelAction, {
    key: idempotencyKey,
  });
  // Controlled, so a refusal never wipes the reason (React 19 resets uncontrolled fields).
  const [reason, setReason] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);

  return (
    <ActionDialog
      refreshOnDone
      triggerLabel={isRevision ? 'Discard revision' : 'Cancel quotation'}
      title={
        isRevision
          ? `Cancel revision ${revisionNo === undefined ? '' : `${revisionNo} `}of ${number}?`
          : `Cancel ${number}?`
      }
      intro={
        isRevision
          ? `Cancelling discards this revision${awaitingApproval ? ' and its approval request' : ''}. If the earlier revision was sent or approved, it becomes the live quotation again (a sent one can be answered by the customer again); otherwise the quotation ends as Cancelled.`
          : awaitingApproval
            ? 'Cancelling ends this quotation and its approval request: the approver no longer sees it. It cannot be edited, submitted or sent afterwards, and it stays in the list as Cancelled.'
            : 'Cancelling ends this quotation. It cannot be edited, submitted or sent afterwards, and it stays in the list as Cancelled.'
      }
      formId={formId}
      submitLabel={isRevision ? 'Discard revision' : 'Cancel quotation'}
      pending={pending}
      done={state.done}
    >
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">Cancelled. Close this to see the new status.</p>
        </div>
      ) : (
        <form noValidate id={formId} ref={formRef} action={formAction}>
          <input type="hidden" name="quotationId" value={quotationId} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={state.key} />

          <fieldset className={styles.form} disabled={pending}>
            <ErrorSummary
              error={state.error}
              reload={state.reload && !pending}
              reloadHref={reloadHref}
              summaryRef={summaryRef}
            />

            <Field
              label="Why are you cancelling it?"
              hint="Kept with the quotation, so everyone can see why it ended."
              error={state.errors?.reason}
            >
              {(control) => (
                <Textarea
                  name="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={4}
                  maxLength={1000}
                  {...control}
                />
              )}
            </Field>
          </fieldset>
          <PendingLine pending={pending} words="Cancelling the quotation" />
        </form>
      )}
    </ActionDialog>
  );
}
