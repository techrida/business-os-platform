'use client';

import type { EvidenceKind } from '@bos/contracts';
import { useActionState, useId, useRef, useState } from 'react';

import { confirmEvidenceAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { Field, Textarea } from '@/components/ui/field';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';
import { EVIDENCE_LABELS, EVIDENCE_ORDER } from './eligibility';
import { Choices } from './outcome-dialog';
import { Checkbox } from '@/components/ui/checkbox';

export interface ConfirmEvidenceDialogProps {
  quotationId: string;
  versionId: string;
  number: string;
  revisionNo: number;
  /** What the company's evidence policy asks for, in plain words, e.g. "a contract and a purchase order". */
  policyText?: string | undefined;
  /** The kinds the customer said they gave when accepting: ticked to start with. */
  initialKinds: readonly EvidenceKind[];
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Confirm evidence (F1-Q28): the customer accepted in the portal, and a staff member records which evidence
 * they now hold and checked (a signed quotation, a purchase order, a contract). It must meet the company's
 * evidence policy; the sales order can be confirmed only after this.
 */
export function ConfirmEvidenceDialog({
  quotationId,
  versionId,
  number,
  revisionNo,
  policyText,
  initialKinds,
  idempotencyKey,
  reloadHref,
}: ConfirmEvidenceDialogProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    confirmEvidenceAction,
    { key: idempotencyKey },
  );
  // Controlled, so a refusal never clears what was ticked or typed (React 19 resets uncontrolled fields).
  const [kinds, setKinds] = useState<EvidenceKind[]>([...initialKinds]);
  const [comment, setComment] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);

  return (
    <ActionDialog
      triggerLabel="Confirm evidence"
      triggerVariant="primary"
      title={`Confirm acceptance evidence for revision ${revisionNo}`}
      intro={`Tick the evidence you hold and checked for ${number}, revision ${revisionNo}. Your name and the time are recorded, and Accounts can then confirm the sales order.`}
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
        <form noValidate id={formId} ref={formRef} action={formAction}>
          <input type="hidden" name="quotationId" value={quotationId} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          <fieldset className={styles.form} disabled={pending}>
            <ErrorSummary
              error={state.error}
              reload={state.reload && !pending}
              reloadHref={reloadHref}
              summaryRef={summaryRef}
            />
            <Choices
              legend="Evidence you checked"
              hint={policyText ? `Your company asks for ${policyText}.` : undefined}
              error={state.errors?.evidence}
            >
              {EVIDENCE_ORDER.map((kind) => (
                <label key={kind} className={styles.choice}>
                  <Checkbox
                    name="evidenceKinds"
                    value={kind}
                    checked={kinds.includes(kind)}
                    onCheckedChange={(nextChecked) =>
                      setKinds((prev) =>
                        nextChecked ? [...prev, kind] : prev.filter((k) => k !== kind),
                      )
                    }
                  />
                  {EVIDENCE_LABELS[kind]}
                </label>
              ))}
            </Choices>
            <Field label="Note" optional error={state.errors?.comment}>
              {(control) => (
                <Textarea
                  name="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  {...control}
                />
              )}
            </Field>
          </fieldset>
          <PendingLine pending={pending} words="Confirming the evidence" />
        </form>
      )}
    </ActionDialog>
  );
}
