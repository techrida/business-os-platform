'use client';

import { useActionState, useRef, useState } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
} from '@/components/ui/transaction-dialog';
import styles from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';

import { confirmOrderAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';

import { ErrorSummary } from './error-summary';

export interface ConfirmOption {
  /** The quotation's `currentVersionId`: the version the order is confirmed from. */
  versionId: string;
  /** Number, customer and total, already worded by the server. */
  label: string;
}

export interface ConfirmOrderDialogProps {
  /** The accepted quotations, or null when they could not be read. */
  options: readonly ConfirmOption[] | null;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Confirm from quotation: a trigger and a native modal dialog, in the frame the quotation actions
 * use. The evidence is typed as document ids, one per line, because the workspace has no document
 * picker yet; the platform decides whether what was attached satisfies the evidence policy and says
 * so plainly when it does not. On success the action opens the new order.
 */
export function ConfirmOrderDialog(props: ConfirmOrderDialogProps) {
  return (
    <ActionDialog
      triggerLabel="Confirm from quotation"
      triggerVariant="primary"
      title="Confirm a sales order"
      intro="Turn an accepted quotation into a sales order. Its lines and totals are copied as they were accepted, and the billing schedule is built from them."
    >
      <ConfirmBody {...props} />
    </ActionDialog>
  );
}

function ConfirmBody({ options, idempotencyKey, reloadHref }: ConfirmOrderDialogProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(confirmOrderAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe what the
  // person typed when the API refuses.
  const [version, setVersion] = useState('');
  const [evidence, setEvidence] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);

  if (options === null) {
    return (
      <div className={styles.form}>
        <Alert
          tone="error"
          role="alert"
          title="The accepted quotations did not load"
          actions={<a href={reloadHref}>Reload the sales orders</a>}
        >
          Nothing was confirmed. Reload the page, then open this again.
        </Alert>
        <div className={styles.buttons}>
          <DialogCloseButton>Close</DialogCloseButton>
        </div>
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className={styles.form}>
        <p className={styles.intro}>
          No accepted quotations are waiting. A quotation appears here once the customer has
          accepted it.
        </p>
        <div className={styles.buttons}>
          <DialogCloseButton>Close</DialogCloseButton>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef}>
      <form action={formAction} className={styles.form}>
        <input type="hidden" name="idempotencyKey" value={state.key} />

        <ErrorSummary
          error={state.error}
          reload={state.reload}
          reloadHref={reloadHref}
          summaryRef={summaryRef}
        />

        <Field label="Accepted quotation" error={state.errors?.quotation}>
          {(control) => (
            <Select
              name="quotationVersionId"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              {...control}
            >
              <option value="">Choose a quotation</option>
              {options.map((option) => (
                <option key={option.versionId} value={option.versionId}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Evidence documents (optional)"
          hint="Document ids, one per line: the customer purchase order, a contract or the signed quotation. If the company's evidence policy needs them and they are missing, the platform refuses and says so."
          error={state.errors?.evidence}
        >
          {(control) => (
            <Textarea
              name="evidenceDocumentIds"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>

        <div className={styles.buttons}>
          <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
          <Button type="submit" disabled={pending}>
            Confirm order
          </Button>
        </div>
        <PendingLine pending={pending} words="Confirming the order" />
      </form>
    </div>
  );
}
