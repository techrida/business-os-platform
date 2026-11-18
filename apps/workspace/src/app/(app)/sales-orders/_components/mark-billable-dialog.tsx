'use client';

import { useActionState, useRef, useState } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/ui/transaction-dialog';
import styles from '@/components/p2/quotations/actions.module.css';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

import { markBillableAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';

import { ErrorSummary } from './error-summary';

export interface EvidenceOption {
  documentId: string;
  /** Kind and the end of the id, already worded by the server. */
  label: string;
}

export interface MarkBillableDialogProps {
  salesOrderId: string;
  scheduleLineId: string;
  /** The step's name, for the title. */
  lineLabel: string;
  /** The order's `version`: schedule lines carry none of their own. */
  version: number;
  /** The order's evidence: the preferred source of the document. */
  evidence: readonly EvidenceOption[];
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Mark a milestone or acceptance step billable. The step needs a document that shows it happened:
 * the form offers the order's own evidence first and says so, and takes another document id only
 * when the one needed is not in that list.
 */
export function MarkBillableDialog(props: MarkBillableDialogProps) {
  return (
    <ActionDialog
      triggerLabel="Mark billable"
      title={`Mark "${props.lineLabel}" billable`}
      intro="Use this once the milestone or the customer's acceptance has happened. The step needs a document that shows it. After that, the invoice can be drafted from it."
    >
      <MarkBody {...props} />
    </ActionDialog>
  );
}

function MarkBody({
  salesOrderId,
  scheduleLineId,
  version,
  evidence,
  idempotencyKey,
  reloadHref,
}: MarkBillableDialogProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(markBillableAction, {
    key: idempotencyKey,
  });
  const [chosen, setChosen] = useState('');
  const [other, setOther] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  const listed = evidence.length > 0;

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">Marked billable. Close this to see the new status.</p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="salesOrderId" value={salesOrderId} />
          <input type="hidden" name="scheduleLineId" value={scheduleLineId} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={state.key} />

          <ErrorSummary
            error={state.error}
            reload={state.reload}
            reloadHref={reloadHref}
            summaryRef={summaryRef}
          />

          {listed ? (
            <Field
              label="Evidence document"
              hint="Choose from the evidence already attached to this order. This is the preferred way."
              error={state.errors?.document}
            >
              {(control) => (
                <Select
                  name="evidenceDocumentId"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                  {...control}
                >
                  <option value="">Choose a document</option>
                  {evidence.map((item) => (
                    <option key={item.documentId} value={item.documentId}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}

          <Field
            label={listed ? 'Or another document id' : 'Document id'}
            hint={
              listed
                ? 'Only if the document you need is not in the list.'
                : 'There is no evidence attached to this order yet. Enter the id of the document that shows this step was done.'
            }
            error={listed ? undefined : state.errors?.document}
          >
            {(control) => (
              <Input
                name="otherDocumentId"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                {...control}
              />
            )}
          </Field>

          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              Mark billable
            </Button>
          </div>
          <PendingLine pending={pending} words="Marking the step billable" />
        </form>
      )}
    </div>
  );
}
