'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import {
  ActionDialog,
  DialogCloseButton,
  ErrorSummary,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/p2/quotations/action-dialog';
import { removeLooseAction, itemAction, type ItemState } from './item-actions';

export function ItemForm({
  caseId,
  itemKey,
  label,
  version,
  retryKey,
  intent,
}: {
  caseId: string;
  itemKey: string;
  label: string;
  version: number;
  retryKey: string;
  intent: 'approve' | 'reject' | 'detach';
}) {
  const [state, action, pending] = useActionState<ItemState, FormData>(itemAction, {
    key: retryKey,
  });
  const [comment, setComment] = useState('');
  const wrap = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrap, summary);
  useReloadWhenClosed(state.done, wrap);
  useEffect(() => {
    if (state.done && intent !== 'reject') window.location.reload();
  }, [state.done, intent]);
  return (
    <form ref={wrap} action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="itemKey" value={itemKey} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="intent" value={intent} />
      <ErrorSummary
        reloadLabel="Reload this case"
        error={state.error}
        reload={state.reload}
        reloadHref={`/verification/${caseId}`}
        summaryRef={summary}
      />
      {state.done ? (
        <>
          <p role="status">{intent === 'detach' ? 'File removed.' : 'Document decision saved.'}</p>
          <DialogCloseButton>Done</DialogCloseButton>
        </>
      ) : (
        <>
          {intent === 'reject' ? (
            <Field
              label="Rejection reason"
              error={state.errors?.comment}
              hint="The authorized Sales creator can read this reason."
            >
              {(control) => (
                <Textarea
                  {...control}
                  name="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={2000}
                  rows={4}
                />
              )}
            </Field>
          ) : null}
          <Button
            type="submit"
            disabled={pending}
            aria-label={`${intent === 'detach' ? 'Remove' : intent === 'approve' ? 'Approve' : 'Reject'} ${label}`}
          >
            {intent === 'approve' ? (
              'Approve'
            ) : intent === 'reject' ? (
              'Reject document'
            ) : (
              <Icon name="x" size={18} />
            )}
          </Button>
          {intent === 'reject' ? (
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
          ) : null}
        </>
      )}
      <PendingLine pending={pending} words="Saving document decision" />
    </form>
  );
}
export function ItemReview(props: {
  caseId: string;
  itemKey: string;
  label: string;
  version: number;
  approveKey: string;
  rejectKey: string;
  canApprove: boolean;
}) {
  return (
    <div>
      {props.canApprove ? (
        <ItemForm {...props} retryKey={props.approveKey} intent="approve" />
      ) : (
        <p>Approval requires clean, unexpired and readable bound evidence.</p>
      )}
      <ActionDialog
        triggerLabel="Reject"
        title={`Reject ${props.label}`}
        intro="The case remains submitted. Reject the case to allow Sales to replace this file."
      >
        <ItemForm {...props} retryKey={props.rejectKey} intent="reject" />
      </ActionDialog>
    </div>
  );
}
export function RemoveLoose({
  caseId,
  documentId,
  filename,
}: {
  caseId: string;
  documentId: string;
  filename: string;
}) {
  const [state, action, pending] = useActionState<ItemState, FormData>(removeLooseAction, {
    key: documentId,
  });
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.done) window.location.reload();
    else if (state.error) summary.current?.focus();
  }, [state]);
  return (
    <form action={action}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <ErrorSummary
        reloadLabel="Reload this case"
        error={state.error}
        reload={state.reload}
        reloadHref={`/verification/${caseId}`}
        summaryRef={summary}
      />
      <Button type="submit" disabled={pending} aria-label={`Remove ${filename}`}>
        <Icon name="x" size={18} />
      </Button>
    </form>
  );
}
