'use client';

import { useActionState, useId, useRef, useState } from 'react';

import { reviseAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { Field, Textarea } from '@/components/ui/field';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';

export interface ReviseFormProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  /** True when revising marks the current revision Superseded (approved or sent). */
  supersedes: boolean;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Revise: a new draft revision with a mandatory reason. On success the server action redirects to
 * the edit page, so there is no confirmation to show here.
 */
export function ReviseForm({
  number,
  supersedes,
  quotationId,
  versionId,
  version,
  idempotencyKey,
  reloadHref,
}: ReviseFormProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(reviseAction, {
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
      triggerLabel="Revise"
      title={`Revise ${number}`}
      intro={
        supersedes
          ? 'This starts a new draft revision and marks the current one Superseded. It stays in the revision list as a record.'
          : 'This starts a new draft revision. The current one stays in the revision list as a record.'
      }
      formId={formId}
      submitLabel="Start revision"
      pending={pending}
    >
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
            label="Why are you revising it?"
            hint="Kept with the new revision, so everyone can see why it changed."
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
        <PendingLine pending={pending} words="Starting the revision" />
      </form>
    </ActionDialog>
  );
}
