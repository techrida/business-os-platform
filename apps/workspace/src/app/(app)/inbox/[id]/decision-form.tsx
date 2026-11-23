'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from '../inbox.module.css';
import { decideAction, type DecisionState } from './actions';

const DECISIONS = [
  {
    intent: 'approve',
    label: 'Approve',
    title: 'Approve request',
    guidance:
      'Your approval is recorded. If another step is required, the request goes to the next approver.',
    field: 'Comment',
    placeholder: 'Anything the requester should know',
  },
  {
    intent: 'return',
    label: 'Return for changes',
    title: 'Return request for changes',
    guidance: 'The requester can update and resubmit this request. Tell them what needs to change.',
    field: 'Reason for return',
    placeholder: 'Describe what needs to change',
  },
  {
    intent: 'reject',
    label: 'Reject',
    title: 'Reject request',
    guidance: 'Rejection ends this approval. The reason is recorded in the audit trail.',
    field: 'Reason for rejection',
    placeholder: 'Explain why you are rejecting the request',
  },
] as const;

type Intent = (typeof DECISIONS)[number]['intent'];

/** Each decision opens its own confirmation. All three use the same version and retry key. */
export function DecisionForm({
  requestId,
  documentNumber,
  version,
  idempotencyKey,
  reloadHref,
}: {
  requestId: string;
  documentNumber: string;
  version: number;
  idempotencyKey: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(decideAction, {
    key: idempotencyKey,
  });
  const [intent, setIntent] = useState<Intent | null>(null);
  const [openingState, setOpeningState] = useState(state);
  // React resets uncontrolled fields when an action returns. Keep each decision's text across a refusal or dismissal.
  const [comments, setComments] = useState({ approve: '', return: '', reject: '' });
  const summaryRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const formId = useId();
  const failure = state === openingState ? null : state;

  useEffect(() => {
    if (failure?.commentError) {
      commentRef.current?.focus();
      toast.error(failure.commentError);
    } else if (failure?.error) {
      summaryRef.current?.focus();
      toast.error('Decision not recorded', { description: failure.error });
    }
  }, [failure]);

  return (
    <div className={styles.buttons}>
      {DECISIONS.map((decision) => {
        const approving = decision.intent === 'approve';
        const rejecting = decision.intent === 'reject';
        return (
          <Dialog
            key={decision.intent}
            open={intent === decision.intent}
            onOpenChange={(open) => {
              setIntent(open ? decision.intent : null);
              if (open) setOpeningState(state);
            }}
            trigger={
              <Button
                variant={approving ? 'primary' : rejecting ? 'tertiary' : 'secondary'}
                className={rejecting ? styles.rejectTrigger : undefined}
                disabled={pending}
              >
                {decision.label}
              </Button>
            }
            size="small"
            title={decision.title}
            description={documentNumber}
            locked={pending}
            closeOnOutsideClick={false}
            footer={
              <>
                <DialogClose asChild>
                  <Button size="small" variant="secondary" disabled={pending}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  form={formId}
                  size="small"
                  className={rejecting ? styles.danger : undefined}
                  disabled={pending || state.reload}
                  aria-busy={pending || undefined}
                >
                  {pending ? 'Sending…' : decision.label}
                </Button>
              </>
            }
          >
            {intent === decision.intent ? (
              <form id={formId} action={formAction} className={styles.decision} noValidate>
                <input type="hidden" name="requestId" value={requestId} />
                <input type="hidden" name="expectedVersion" value={version} />
                <input type="hidden" name="idempotencyKey" value={state.key} />
                <input type="hidden" name="intent" value={intent} />
                <Alert tone={rejecting ? 'error' : 'info'}>{decision.guidance}</Alert>
                {state.reload || failure?.error ? (
                  <Alert
                    ref={summaryRef}
                    tabIndex={-1}
                    tone="error"
                    role="alert"
                    actions={state.reload ? <a href={reloadHref}>Reload this request</a> : null}
                  >
                    {state.error}
                  </Alert>
                ) : null}
                <Field label={decision.field} optional={approving} error={failure?.commentError}>
                  {(control) => (
                    <Textarea
                      {...control}
                      ref={commentRef}
                      name="comment"
                      value={comments[intent]}
                      onChange={(event) => {
                        const comment = event.target.value;
                        setComments((current) => ({ ...current, [intent]: comment }));
                      }}
                      placeholder={decision.placeholder}
                      required={!approving}
                      rows={4}
                      maxLength={2000}
                    />
                  )}
                </Field>
              </form>
            ) : null}
          </Dialog>
        );
      })}
    </div>
  );
}
