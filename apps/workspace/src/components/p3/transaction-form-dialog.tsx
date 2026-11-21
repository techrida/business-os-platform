'use client';

import { useActionState, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFocusOnProblem } from '@/components/p2/quotations/action-dialog';

import styles from './transaction-form-dialog.module.css';

interface TransactionState {
  key: string;
  done?: boolean;
  error?: string;
  errors?: object;
  reload?: boolean;
}

export function TransactionFormDialog<State extends TransactionState>({
  trigger,
  primary = false,
  destructive = false,
  title,
  description,
  submit,
  successMessage,
  initial,
  action,
  reloadHref,
  children,
  size = 'small',
  blocked = false,
}: {
  trigger: string;
  primary?: boolean;
  destructive?: boolean;
  title: string;
  description: string;
  submit: string;
  successMessage: string;
  initial: State;
  action: (previous: State, form: FormData) => Promise<State>;
  reloadHref: string;
  children: (state: State) => ReactNode;
  size?: 'small' | 'large';
  /** Keeps the submit button off while a field is not ready (a file still uploading, an infected file). */
  blocked?: boolean | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [{ value: state }, dispatch, pending] = useActionState<{ value: State }, FormData>(
    async ({ value: previous }, form) => {
      const result = await action(previous, form);
      if (result.done) {
        setOpen(false);
        toast.success(successMessage);
        router.refresh();
      }
      return { value: result };
    },
    { value: initial },
  );
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);
  return (
    <Dialog
      title={title}
      description={description}
      size={size}
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant={primary ? 'primary' : 'secondary'}>{trigger}</Button>}
      locked={pending}
      tone={destructive ? 'destructive' : 'default'}
      initialFocusRef={destructive ? cancelRef : undefined}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button ref={cancelRef} variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            className={destructive ? styles.danger : undefined}
            type="submit"
            form={formId}
            disabled={pending || blocked}
            aria-busy={pending || undefined}
          >
            {submit}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} action={dispatch} className={styles.form}>
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {state.error && (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
          >
            {state.error}
          </Alert>
        )}
        {children(state)}
      </form>
    </Dialog>
  );
}
