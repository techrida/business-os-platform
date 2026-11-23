'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { cancelPrAction, submitPrAction } from '../actions';
import { commandStart, type CommandState } from '../_lib/state';
import styles from '../requests.module.css';

type Action = (prev: CommandState, form: FormData) => Promise<CommandState>;

/**
 * A success revalidates the page, which then stops offering the form that sent it, so the toast is
 * raised where the result arrives rather than from an effect in a form that may already be gone.
 */
function toastOnSuccess(action: Action, onSuccess?: () => void): Action {
  return async (prev, form) => {
    const next = await action(prev, form);
    if (next.saved) {
      toast.success(next.saved);
      onSuccess?.();
    }
    return next;
  };
}

function Hidden({ prId, version, state }: { prId: string; version: number; state: CommandState }) {
  return (
    <>
      <input type="hidden" name="prId" value={prId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
    </>
  );
}

function Outcome({ state, reloadHref }: { state: CommandState; reloadHref: string }) {
  if (state.error) {
    return (
      <Alert
        tone="error"
        role="alert"
        title={state.reload ? 'This page is out of date' : 'Not done'}
        actions={state.reload ? <a href={reloadHref}>Reload this request</a> : null}
      >
        {state.error}
      </Alert>
    );
  }
  return null;
}

/**
 * Sends a draft or returned request to its approvers from a fixed-footer confirmation dialog.
 * The platform refuses (422) when a step has nobody who may decide it, and nothing is submitted;
 * the reason is shown as the platform wrote it.
 */
export function SubmitForm({
  prId,
  version,
  idempotencyKey,
  emergency,
  resubmit = false,
  reloadHref,
  action = submitPrAction,
}: {
  prId: string;
  version: number;
  idempotencyKey: string;
  emergency: boolean;
  resubmit?: boolean;
  reloadHref: string;
  action?: Action;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CommandState, FormData>(
    toastOnSuccess(action, () => setOpen(false)),
    commandStart(idempotencyKey),
  );
  const formId = useId();
  const label = resubmit ? 'Resubmit' : 'Submit for approval';
  const description = emergency
    ? 'Submitting sends it to the department head, then to Management because it is an emergency.'
    : 'Submitting sends it to the department head for a decision. You cannot edit it while it waits.';
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="primary">{label}</Button>}
      title={resubmit ? 'Resubmit for approval?' : 'Submit for approval?'}
      description={description}
      size="small"
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? 'Submitting' : label}
          </Button>
        </>
      }
    >
      <form noValidate id={formId} action={formAction} className={styles.panelForm}>
        <Hidden prId={prId} version={version} state={state} />
        <Outcome state={state} reloadHref={reloadHref} />
      </form>
    </Dialog>
  );
}

/** Cancels a draft after one confirmation. A submitted request cannot be cancelled. */
export function CancelForm({
  prId,
  version,
  idempotencyKey,
  reloadHref,
  action = cancelPrAction,
}: {
  prId: string;
  version: number;
  idempotencyKey: string;
  reloadHref: string;
  action?: Action;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CommandState, FormData>(
    toastOnSuccess(action, () => setOpen(false)),
    commandStart(idempotencyKey),
  );
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="secondary">Cancel request</Button>}
      title="Cancel this draft?"
      description="It cannot be reopened afterwards."
      size="small"
      tone="destructive"
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Keep it
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? 'Cancelling' : 'Yes, cancel this request'}
          </Button>
        </>
      }
    >
      <form noValidate id={formId} action={formAction} className={styles.panelForm}>
        <Hidden prId={prId} version={version} state={state} />
        <Outcome state={state} reloadHref={reloadHref} />
      </form>
    </Dialog>
  );
}
