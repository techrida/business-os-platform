'use client';

import { useActionState, useRef, useState, type RefObject } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/ui/transaction-dialog';
import styles from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import type { PaymentActions } from '../_lib/status';

import { rejectAction, reverseAction, verifyAction, type ReviewState } from './review-actions';

export interface ReviewDialogsProps {
  paymentId: string;
  /** The `version` of the payment the person is looking at. */
  version: number;
  /** The receipt number, or null before verification. */
  number: string | null;
  actions: PaymentActions;
  /** One UUID per action, generated on the server for this render. */
  keys: { verify: string; reject: string; reverse: string };
}

/**
 * Verify, Reject and Reverse as native modal dialogs. Which of them show depends on the payment's
 * status only; whether the person may use them is the server's call, and its refusal (a role it
 * lacks, or the person who recorded the payment trying to verify it) is shown inside the dialog.
 */
export function ReviewDialogs({ paymentId, version, number, actions, keys }: ReviewDialogsProps) {
  const reloadHref = `/payments/${encodeURIComponent(paymentId)}`;
  const common = { paymentId, version, reloadHref };
  return (
    <>
      {actions.verify ? <VerifyDialog {...common} idempotencyKey={keys.verify} /> : null}
      {actions.reject ? (
        <ReasonDialog
          {...common}
          idempotencyKey={keys.reject}
          action={rejectAction}
          triggerLabel="Reject"
          title="Reject this payment"
          intro="Finance rejects a payment when the proof does not support it. The customer's invoices stay open. The reason is kept with the payment."
          reasonLabel="Reason for rejecting"
          submitLabel="Reject payment"
          pendingWords="Rejecting the payment"
          doneWords="The payment was rejected."
        />
      ) : null}
      {actions.reverse ? (
        <ReasonDialog
          {...common}
          idempotencyKey={keys.reverse}
          action={reverseAction}
          triggerLabel="Reverse payment"
          title={number !== null ? `Reverse receipt ${number}` : 'Reverse this payment'}
          intro="For a bounced cheque or a receipt entered by mistake. Every allocation of this payment is undone first, so the invoices become open again. This cannot be undone."
          reasonLabel="Reason for reversing"
          submitLabel="Reverse payment"
          pendingWords="Reversing the payment"
          doneWords="The payment was reversed and its allocations were undone."
        />
      ) : null}
    </>
  );
}

interface FrameProps {
  paymentId: string;
  version: number;
  idempotencyKey: string;
  reloadHref: string;
}

function Problem({
  error,
  reload,
  reloadHref,
  summaryRef,
}: {
  error: string | undefined;
  reload: boolean | undefined;
  reloadHref: string;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  if (!error) return null;
  return (
    <Alert
      ref={summaryRef}
      tabIndex={-1}
      tone="error"
      role="alert"
      actions={reload ? <a href={reloadHref}>Reload this payment</a> : null}
    >
      {error}
    </Alert>
  );
}

function HiddenFields({
  paymentId,
  version,
  keyValue,
}: {
  paymentId: string;
  version: number;
  keyValue: string;
}) {
  return (
    <>
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={keyValue} />
    </>
  );
}

function VerifyDialog(props: FrameProps) {
  return (
    <ActionDialog
      triggerLabel="Verify payment"
      triggerVariant="primary"
      title="Verify this payment"
      intro="Verifying confirms the proof matches the money received. It gives the payment its receipt number and records the credit, but it does not settle any invoice until you allocate it."
    >
      <VerifyBody {...props} />
    </ActionDialog>
  );
}

function VerifyBody({ paymentId, version, idempotencyKey, reloadHref }: FrameProps) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(verifyAction, {
    key: idempotencyKey,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">The payment was verified. Close this to see its receipt number.</p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <HiddenFields paymentId={paymentId} version={version} keyValue={state.key} />
          <Problem
            error={state.error}
            reload={state.reload}
            reloadHref={reloadHref}
            summaryRef={summaryRef}
          />
          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              Verify payment
            </Button>
          </div>
          <PendingLine pending={pending} words="Verifying the payment" />
        </form>
      )}
    </div>
  );
}

function ReasonDialog({
  action,
  triggerLabel,
  title,
  intro,
  reasonLabel,
  submitLabel,
  pendingWords,
  doneWords,
  ...frame
}: FrameProps & {
  action: (prev: ReviewState, form: FormData) => Promise<ReviewState>;
  triggerLabel: string;
  title: string;
  intro: string;
  reasonLabel: string;
  submitLabel: string;
  pendingWords: string;
  doneWords: string;
}) {
  return (
    <ActionDialog triggerLabel={triggerLabel} title={title} intro={intro}>
      <ReasonBody
        {...frame}
        action={action}
        reasonLabel={reasonLabel}
        submitLabel={submitLabel}
        pendingWords={pendingWords}
        doneWords={doneWords}
      />
    </ActionDialog>
  );
}

function ReasonBody({
  paymentId,
  version,
  idempotencyKey,
  reloadHref,
  action,
  reasonLabel,
  submitLabel,
  pendingWords,
  doneWords,
}: FrameProps & {
  action: (prev: ReviewState, form: FormData) => Promise<ReviewState>;
  reasonLabel: string;
  submitLabel: string;
  pendingWords: string;
  doneWords: string;
}) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(action, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe the reason
  // the person typed when the API refuses.
  const [reason, setReason] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">{doneWords} Close this to see the new status.</p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <HiddenFields paymentId={paymentId} version={version} keyValue={state.key} />
          <Problem
            error={state.error}
            reload={state.reload}
            reloadHref={reloadHref}
            summaryRef={summaryRef}
          />
          <Field label={reasonLabel} error={state.errors?.reason}>
            {(control) => (
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={1000}
                required
                {...control}
              />
            )}
          </Field>
          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </div>
          <PendingLine pending={pending} words={pendingWords} />
        </form>
      )}
    </div>
  );
}
