'use client';

import { useActionState, useId, useRef, useState, type ReactNode } from 'react';

import { outcomeAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';

import {
  ActionDialog,
  DialogCloseButton,
  ErrorSummary,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from './action-dialog';
import styles from './actions.module.css';
import { EVIDENCE_LABELS, EVIDENCE_ORDER } from './eligibility';

export interface OutcomeDialogProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  /** Today in Kathmandu, `YYYY-MM-DD`: the default date, and the latest the form allows. */
  today: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

type Outcome = '' | 'accepted' | 'rejected';

/** A fieldset of native radios or checkboxes, with the hint and error lines Field gives a single control. */
function Choices({
  legend,
  hint,
  error,
  children,
}: {
  legend: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  const base = useId();
  const describedBy = [hint ? `${base}-hint` : '', error ? `${base}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      className={styles.choices}
      aria-describedby={describedBy || undefined}
      {...(error ? { 'data-invalid': '' } : {})}
    >
      <legend className={styles.legend}>{legend}</legend>
      {hint ? (
        <span id={`${base}-hint`} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {children}
      {error ? (
        <span id={`${base}-error`} className={styles.error}>
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

/** Record outcome: the customer accepted or rejected the sent quotation. */
export function OutcomeDialog({ number, ...rest }: OutcomeDialogProps) {
  return (
    <ActionDialog
      triggerLabel="Record outcome"
      title={`Record the outcome of ${number}`}
      intro="Write down what the customer answered. Accepting needs at least one kind of evidence. Rejecting needs a comment."
    >
      <OutcomeBody {...rest} />
    </ActionDialog>
  );
}

function OutcomeBody({
  quotationId,
  versionId,
  version,
  today,
  idempotencyKey,
  reloadHref,
}: Omit<OutcomeDialogProps, 'number'>) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(outcomeAction, {
    key: idempotencyKey,
  });
  // Controlled, so a refusal never wipes what the person entered (React 19 resets the rest).
  const [outcome, setOutcome] = useState<Outcome>('');
  const [decidedOn, setDecidedOn] = useState(today);
  const [evidence, setEvidence] = useState<readonly string[]>([]);
  const [comment, setComment] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">
            Recorded as {outcome === 'accepted' ? 'accepted' : 'rejected'}. Close this to see the
            new status.
          </p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="quotationId" value={quotationId} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={state.key} />

          <ErrorSummary
            error={state.error}
            reload={state.reload}
            reloadHref={reloadHref}
            summaryRef={summaryRef}
          />

          <Choices legend="What did the customer say?" error={state.errors?.outcome}>
            {(['accepted', 'rejected'] as const).map((value) => (
              <label key={value} className={styles.choice}>
                <input
                  type="radio"
                  name="outcome"
                  value={value}
                  checked={outcome === value}
                  onChange={() => setOutcome(value)}
                />
                {value === 'accepted' ? 'Accepted' : 'Rejected'}
              </label>
            ))}
          </Choices>

          <Field label="Date the customer answered" error={state.errors?.decidedOn}>
            {(control) => (
              <Input
                type="date"
                name="decidedOn"
                value={decidedOn}
                max={today}
                onChange={(e) => setDecidedOn(e.target.value)}
                {...control}
              />
            )}
          </Field>

          <Choices
            legend="Evidence the customer gave"
            hint={
              outcome === 'rejected'
                ? 'Optional when the customer rejected.'
                : 'Required to record an accepted quotation.'
            }
            error={state.errors?.evidence}
          >
            {EVIDENCE_ORDER.map((kind) => (
              <label key={kind} className={styles.choice}>
                <input
                  type="checkbox"
                  name="evidenceKinds"
                  value={kind}
                  checked={evidence.includes(kind)}
                  onChange={(e) =>
                    setEvidence((prev) =>
                      e.target.checked ? [...prev, kind] : prev.filter((k) => k !== kind),
                    )
                  }
                />
                {EVIDENCE_LABELS[kind]}
              </label>
            ))}
          </Choices>

          <Field
            label="Comment"
            hint={
              outcome === 'accepted'
                ? 'Optional when the customer accepted.'
                : 'Required when the customer rejected.'
            }
            error={state.errors?.comment}
          >
            {(control) => (
              <Textarea
                name="comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                maxLength={2000}
                {...control}
              />
            )}
          </Field>

          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              Record outcome
            </Button>
          </div>
          <PendingLine pending={pending} words="Recording the outcome" />
        </form>
      )}
    </div>
  );
}
