'use client';

import { useActionState, useId, useRef, useState } from 'react';

import { sendAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Field, Select, Textarea } from '@/components/ui/field';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';
import { hasEmail } from './eligibility';

export interface SendContact {
  id: string;
  name: string;
  email: string | null;
}

export interface SendDialogProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  contacts: readonly SendContact[];
  /** The version's own contact when it can receive email, otherwise empty. */
  defaultContactId: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
  /** Why Send is off, or null when it is on. Decided on the server by `sendGate`. */
  blocker: string | null;
}

/**
 * Send to customer. When the gate says no, the button stays in the tab order with `aria-disabled`
 * (a natively disabled button cannot be focused, so its reason would never be read out) and the
 * reason shows in a tooltip on hover and focus (UIP-FORM-011: no text beside the button). A click does nothing.
 */
export function SendDialog(props: SendDialogProps) {
  return props.blocker === null ? <SendForm {...props} /> : <SendBlocked reason={props.blocker} />;
}

function SendBlocked({ reason }: { reason: string }) {
  return (
    <Tooltip content={reason}>
      <Button aria-disabled="true" onClick={(e) => e.preventDefault()}>
        Send to customer
      </Button>
    </Tooltip>
  );
}

function SendForm({
  quotationId,
  versionId,
  version,
  number,
  contacts,
  defaultContactId,
  idempotencyKey,
  reloadHref,
}: SendDialogProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(sendAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe what the
  // person typed when the API refuses.
  const [recipient, setRecipient] = useState(defaultContactId);
  const [message, setMessage] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);

  const chosen = contacts.find((c) => c.id === recipient);

  return (
    <ActionDialog
      triggerLabel="Send to customer"
      triggerVariant="primary"
      title={`Send ${number}`}
      intro="The customer gets an email with a link to their portal, where they can read the quotation. The PDF is never attached and never sent as a file."
      formId={formId}
      submitLabel="Send to customer"
      pending={pending}
      done={state.done}
    >
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status" className={styles.wrap}>
            Sent to {chosen?.name ?? 'the customer'}
            {chosen?.email ? ` (${chosen.email})` : ''}. Close this to see the new status.
          </p>
        </div>
      ) : (
        <form id={formId} ref={formRef} action={formAction}>
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
              label="Send to"
              hint="Only contacts with an email address can be chosen."
              error={state.errors?.recipient}
            >
              {(control) => (
                <Select
                  name="recipientContactId"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  {...control}
                >
                  <option value="">Choose a contact</option>
                  {contacts.map((c) =>
                    hasEmail(c) ? (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.email})
                      </option>
                    ) : (
                      <option key={c.id} value={c.id} disabled>
                        {c.name} (no email address)
                      </option>
                    ),
                  )}
                </Select>
              )}
            </Field>

            <Field label="Message (optional)" error={state.errors?.message}>
              {(control) => (
                <Textarea
                  name="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  {...control}
                />
              )}
            </Field>
          </fieldset>
          <PendingLine pending={pending} words="Sending the quotation" />
        </form>
      )}
    </ActionDialog>
  );
}
