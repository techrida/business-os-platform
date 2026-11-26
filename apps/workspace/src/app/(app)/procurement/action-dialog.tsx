'use client';

import { useActionState, useId, useRef, type ComponentProps, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, type DialogSize } from '@/components/ui/dialog';
import {
  ErrorSummary,
  PendingLine,
  useFocusOnProblem,
  useRefreshAfterAction,
} from '@/components/p2/quotations/action-dialog';

import type { ActionState } from './orders/_lib/state';
import styles from './procurement.module.css';

/** Keyed on the render's idempotency key: the refresh after a success starts a fresh form instead of keeping "done". */
export function ProcurementActionDialog(props: ComponentProps<typeof ProcurementActionForm>) {
  return <ProcurementActionForm key={props.idempotencyKey} {...props} />;
}

function ProcurementActionForm({
  triggerLabel,
  triggerVariant = 'secondary',
  title,
  intro,
  action,
  idempotencyKey,
  recordField,
  recordId,
  reloadHref,
  reloadLabel,
  submitLabel,
  submitVariant = 'primary',
  pendingWords,
  size = 'small',
  fields,
}: {
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  title: string;
  intro: string;
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  idempotencyKey: string;
  recordField: 'purchaseOrderId' | 'receiptId';
  recordId: string;
  reloadHref: string;
  reloadLabel: string;
  submitLabel: string;
  submitVariant?: 'primary' | 'secondary';
  pendingWords: string;
  size?: DialogSize;
  fields?: (errors: Record<string, string>) => ReactNode;
}) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {
    key: idempotencyKey,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  const done = state.done !== undefined;
  const refreshAfterAction = useRefreshAfterAction();

  return (
    <Dialog
      trigger={<Button variant={triggerVariant}>{triggerLabel}</Button>}
      title={title}
      description={intro}
      size={size}
      locked={pending}
      closeOnOutsideClick={fields === undefined}
      onOpenChange={(open) => {
        if (!open && done) refreshAfterAction();
      }}
      footer={
        done ? (
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form={formId} variant={submitVariant} disabled={pending}>
              {submitLabel}
            </Button>
          </>
        )
      }
    >
      <div ref={wrapRef}>
        {done ? (
          <p role="status">{state.done} Close this to see the new status.</p>
        ) : (
          <form noValidate id={formId} action={formAction} className={styles.actionForm}>
            <input type="hidden" name={recordField} value={recordId} />
            <input type="hidden" name="idempotencyKey" value={state.key} />
            <ErrorSummary
              error={state.error}
              reload={state.reload}
              reloadHref={reloadHref}
              reloadLabel={reloadLabel}
              summaryRef={summaryRef}
            />
            {fields?.(state.errors ?? {})}
            <PendingLine pending={pending} words={pendingWords} />
          </form>
        )}
      </div>
    </Dialog>
  );
}
