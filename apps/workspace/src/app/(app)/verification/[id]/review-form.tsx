'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { HeaderAction } from '@/components/ui/header-action';
import { toast } from '@/components/ui/toast';

import { reviewAction, type ReviewState } from '../actions';
import styles from '../verification.module.css';

type Intent = 'approve' | 'reject';

export function ReviewForm({
  caseId,
  version,
  idempotencyKey,
  canReject,
  approvalProblems,
  reloadHref,
}: {
  caseId: string;
  version: number;
  idempotencyKey: string;
  canReject: boolean;
  approvalProblems: string[];
  reloadHref: string;
}) {
  const [state, setState] = useState<ReviewState>({ key: idempotencyKey });
  const [choice, setChoice] = useState<{ intent: Intent; version: number } | null>(null);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [retryUnconfirmed, setRetryUnconfirmed] = useState(false);
  const inFlight = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const formId = useId();
  const canApprove = approvalProblems.length === 0;
  const rejecting = choice?.intent === 'reject';

  useEffect(() => {
    if (state.commentError) commentRef.current?.focus();
    else if (state.error) summaryRef.current?.focus();
  }, [state]);

  function open(intent: Intent, button: HTMLButtonElement) {
    opener.current = button;
    setChoice({ intent, version });
    setState({ key: crypto.randomUUID() });
    setComment('');
    setRetryUnconfirmed(false);
  }

  function close() {
    if (inFlight.current) return;
    setChoice(null);
    requestAnimationFrame(() => opener.current?.focus());
  }

  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice || inFlight.current || state.reload || (rejecting ? !canReject : !canApprove))
      return;
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('intent', choice.intent);
    form.set('comment', comment);
    form.set('expectedVersion', String(choice.version));
    form.set('idempotencyKey', state.key);
    inFlight.current = true;
    setPending(true);
    try {
      const result = await reviewAction(state, form);
      setState(result);
      // A retry after an unknown outcome must send the same reason and decision with the same key.
      setRetryUnconfirmed(Boolean(result.error && result.key === state.key && !result.reload));
      if (result.error || result.commentError) return;
      setChoice(null);
      toast.success(rejecting ? 'Case rejected' : 'Customer approved');
    } catch {
      setRetryUnconfirmed(true);
      setState({ key: state.key, error: 'The decision could not be confirmed. Try again.' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className={styles.headerActions}>
      {canReject ? (
        <Button variant="secondary" onClick={(event) => open('reject', event.currentTarget)}>
          Reject
        </Button>
      ) : null}
      <HeaderAction
        missing={approvalProblems}
        missingTitle="Approval requirements"
        missingLabel="Approval blocked"
        onClick={(event) => open('approve', event.currentTarget)}
      >
        Approve customer
      </HeaderAction>
      <Dialog
        size="small"
        title={rejecting ? 'Reject this case?' : 'Approve this customer?'}
        description={
          rejecting
            ? 'The case will be returned for changes.'
            : 'This marks the customer as verified.'
        }
        tone={rejecting ? 'destructive' : 'default'}
        open={choice !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        locked={pending}
        closeOnOutsideClick={false}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form={formId}
              className={rejecting ? styles.danger : undefined}
              disabled={pending || state.reload || (rejecting ? !canReject : !canApprove)}
              aria-busy={pending || undefined}
            >
              {rejecting ? 'Reject case' : 'Approve customer'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(event) => void decide(event)} className={styles.decision}>
          <Alert tone={rejecting ? 'error' : 'info'}>
            {rejecting
              ? 'Sales will see your reason and can update the documents.'
              : 'The reason is kept with the verification decision.'}
          </Alert>
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              actions={state.reload ? <a href={reloadHref}>Reload this case</a> : null}
            >
              {state.error}
            </Alert>
          ) : null}
          {approvalProblems.length > 0 && !rejecting ? (
            <Alert tone="warning" role="status">
              {approvalProblems.join(' ')}
            </Alert>
          ) : null}
          <Field label="Reason" hint="Required." error={state.commentError}>
            {(control) => (
              <Textarea
                ref={commentRef}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={4}
                maxLength={2000}
                readOnly={pending || retryUnconfirmed}
                {...control}
              />
            )}
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
