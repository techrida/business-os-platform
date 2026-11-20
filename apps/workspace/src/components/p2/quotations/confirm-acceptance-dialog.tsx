'use client';

import { useActionState, useId, useRef } from 'react';

import { confirmAcceptanceAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';

export interface ConfirmAcceptanceDialogProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  revisionNo: number;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Confirm evidence (F1-Q28): the customer accepted, and a staff member records that the evidence they
 * gave (a signed copy, a purchase order, a contract) was checked. Nothing to fill in: the person and
 * the time are recorded by the platform.
 */
export function ConfirmAcceptanceDialog({
  quotationId,
  versionId,
  version,
  number,
  revisionNo,
  idempotencyKey,
  reloadHref,
}: ConfirmAcceptanceDialogProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    confirmAcceptanceAction,
    { key: idempotencyKey },
  );
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);

  return (
    <ActionDialog
      triggerLabel="Confirm evidence"
      triggerVariant="primary"
      title={`Confirm acceptance evidence for revision ${revisionNo}`}
      intro={`Confirm that you checked the evidence the customer gave for ${number}, revision ${revisionNo}, such as the signed quotation or purchase order. Your name and the time are recorded.`}
      formId={formId}
      submitLabel="Confirm evidence"
      pending={pending}
      done={state.done}
    >
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">Evidence confirmed. Close this to see it on the quotation.</p>
        </div>
      ) : (
        <form id={formId} ref={formRef} action={formAction}>
          <input type="hidden" name="quotationId" value={quotationId} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          <div className={styles.form}>
            <ErrorSummary
              error={state.error}
              reload={state.reload && !pending}
              reloadHref={reloadHref}
              summaryRef={summaryRef}
            />
          </div>
          <PendingLine pending={pending} words="Confirming the evidence" />
        </form>
      )}
    </ActionDialog>
  );
}
