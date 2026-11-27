'use client';

import { useActionState, useCallback, useId, useRef, useState, type ReactNode } from 'react';

import { outcomeAction, type ActionState } from '@/app/(app)/quotations/[id]/actions';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Textarea } from '@/components/ui/field';

import { ActionDialog, ErrorSummary, PendingLine, useFocusOnProblem } from './action-dialog';
import styles from './actions.module.css';
import { EVIDENCE_LABELS, EVIDENCE_ORDER } from './eligibility';
import { Checkbox, Radio, RadioGroup } from '@/components/ui/checkbox';

export interface OutcomeDialogProps {
  quotationId: string;
  versionId: string;
  /** The `version` of the version row the person is looking at. */
  version: number;
  number: string;
  /** The revision the outcome is recorded on: always the current one. */
  revisionNo: number;
  /**
   * Why Accepted cannot be recorded now (the opportunity's stage), or null. When set, only Rejected is
   * offered and the reason is shown in its place.
   */
  acceptBlocker?: string | null;
  /** Today in Kathmandu, `YYYY-MM-DD`: the default date, and the latest the form allows. */
  today: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

type Outcome = '' | 'accepted' | 'rejected';

/**
 * A fieldset of radios or checkboxes, with the hint and error lines Field gives a single control.
 * Pass `radios` when the choices are `Radio`s: the fieldset then becomes their `RadioGroup`.
 */
export function Choices({
  legend,
  hint,
  error,
  children,
  radios,
}: {
  legend: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
  radios?: { name: string; value: string; onValueChange: (value: string) => void };
}) {
  const base = useId();
  const describedBy = [hint ? `${base}-hint` : '', error ? `${base}-error` : '']
    .filter(Boolean)
    .join(' ');
  const fieldset = (
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
  return radios ? (
    <RadioGroup asChild {...radios}>
      {fieldset}
    </RadioGroup>
  ) : (
    fieldset
  );
}

/** Record outcome: the customer accepted or rejected the sent quotation. */
export function OutcomeDialog({
  number,
  revisionNo,
  acceptBlocker = null,
  quotationId,
  versionId,
  version,
  today,
  idempotencyKey,
  reloadHref,
}: OutcomeDialogProps) {
  const formId = useId();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(outcomeAction, {
    key: idempotencyKey,
  });
  // Controlled, so a refusal never wipes what the person entered (React 19 resets the rest).
  const [outcome, setOutcome] = useState<Outcome>('');
  const [decidedOn, setDecidedOn] = useState(today);
  const [evidence, setEvidence] = useState<readonly string[]>([]);
  const [comment, setComment] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const [popoverContainer, setPopoverContainer] = useState<HTMLElement>();
  const connectForm = useCallback((form: HTMLFormElement | null) => {
    formRef.current = form;
    setPopoverContainer(form?.closest<HTMLElement>('[role="dialog"]') ?? undefined);
  }, []);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);

  return (
    <ActionDialog
      refreshOnDone
      triggerLabel="Record outcome"
      title={`Record outcome for revision ${revisionNo}`}
      intro={
        acceptBlocker === null
          ? `Write down what the customer answered to ${number}, revision ${revisionNo}. Accepting needs at least one kind of evidence. Rejecting needs a comment.`
          : `Write down what the customer answered to ${number}, revision ${revisionNo}. Rejecting needs a comment.`
      }
      formId={formId}
      submitLabel="Record outcome"
      pending={pending}
      done={state.done}
    >
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">
            Recorded as {outcome === 'accepted' ? 'accepted' : 'rejected'}. Close this to see the
            new status.
          </p>
        </div>
      ) : (
        <form noValidate id={formId} ref={connectForm} action={formAction}>
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

            <Choices
              legend="What did the customer say?"
              hint={acceptBlocker ?? undefined}
              error={state.errors?.outcome}
              radios={{
                name: 'outcome',
                value: outcome,
                onValueChange: (next) => setOutcome(next as Outcome),
              }}
            >
              {(acceptBlocker === null
                ? (['accepted', 'rejected'] as const)
                : (['rejected'] as const)
              ).map((value) => (
                <label key={value} className={styles.choice}>
                  <Radio value={value} />
                  {value === 'accepted' ? 'Accepted' : 'Rejected'}
                </label>
              ))}
            </Choices>

            <Field label="Date the customer answered" error={state.errors?.decidedOn}>
              {(control) => (
                <DatePicker
                  name="decidedOn"
                  value={decidedOn}
                  max={today}
                  onChange={setDecidedOn}
                  popoverContainer={popoverContainer}
                  disabled={pending}
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
                  <Checkbox
                    name="evidenceKinds"
                    value={kind}
                    checked={evidence.includes(kind)}
                    onCheckedChange={(nextChecked) =>
                      setEvidence((prev) =>
                        nextChecked ? [...prev, kind] : prev.filter((k) => k !== kind),
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
          </fieldset>
          <PendingLine pending={pending} words="Recording the outcome" />
        </form>
      )}
    </ActionDialog>
  );
}
