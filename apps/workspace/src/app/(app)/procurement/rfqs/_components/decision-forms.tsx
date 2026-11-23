'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { DecimalInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui/toast';

import styles from '../../requests/requests.module.css';
import groups from './line-rows.module.css';
import { isoToKathmanduLocal, MAX_SCORE_ROWS, type ScoreRowValues } from '../_lib/forms';
import {
  commandStart,
  type CommandState,
  type RfqEditState,
  type RfqFormState,
} from '../_lib/state';

const WIDE = styles.wide ?? '';

/** What the platform already holds for one quotation, shown as it sent it. */
export interface HeldScore {
  criterion: string;
  score: string;
}

/**
 * Scores for one quotation: criterion rows, each a name and a mark from 0 to 100. A row left empty
 * is skipped, and saving a criterion again replaces its mark. Nothing is added up here: the
 * average appears in the quotations table, worked out by the platform. Inputs are controlled so a
 * refusal does not wipe what was typed, and the rows stay after a save so they can be adjusted.
 */
export function ScoreForm({
  action,
  idempotencyKey,
  rfqId,
  quotationId,
  vendorName,
  held,
  reloadHref,
}: {
  action: (prev: RfqEditState, form: FormData) => Promise<RfqEditState>;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  rfqId: string;
  quotationId: string;
  vendorName: string;
  held: HeldScore[];
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RfqEditState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
    count: 0,
  });
  const [rows, setRows] = useState<ScoreRowValues[]>([{ criterion: '', score: '' }]);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    if (state.saved) toast.success(state.saved);
  }, [state]);

  const setRow = (i: number, patch: Partial<ScoreRowValues>): void =>
    setRows((all) => all.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const err = state.errors;

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.panelForm}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="quotationId" value={quotationId} />
      <fieldset className={groups.group}>
        <legend>{`Score ${vendorName}`}</legend>
        <div className={styles.panelForm}>
          {held.length > 0 ? (
            <p className={styles.note}>
              Scored so far:{' '}
              <span className={[styles.long, styles.numeric].join(' ')}>
                {held.map((h) => `${h.criterion} ${h.score}`).join(', ')}
              </span>
            </p>
          ) : null}
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              title={state.reload ? 'This page is out of date' : 'The scores were not saved'}
              actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
            >
              {state.error}
            </Alert>
          ) : null}
          {err.scores ? (
            <p role="alert" className={styles.status}>
              {err.scores}
            </p>
          ) : null}
          {rows.map((row, i) => (
            <div key={i} className={groups.groupGrid}>
              <Field label={`Criterion ${i + 1}`} error={err[`scores.${i}.criterion`]}>
                {(control) => (
                  <Input
                    name={`scores.${i}.criterion`}
                    value={row.criterion}
                    onChange={(e) => setRow(i, { criterion: e.target.value })}
                    maxLength={64}
                    autoComplete="off"
                    {...control}
                  />
                )}
              </Field>
              <Field label={`Score ${i + 1} (0 to 100)`} error={err[`scores.${i}.score`]}>
                {(control) => (
                  // The same bounds the form's own check uses: 0 to 100 with up to 2 decimals.
                  <DecimalInput
                    {...control}
                    name={`scores.${i}.score`}
                    intDigits={3}
                    scale={2}
                    min="0"
                    max="100"
                    value={row.score}
                    onValueChange={(plain) => setRow(i, { score: plain })}
                  />
                )}
              </Field>
            </div>
          ))}
          <div className={styles.actions}>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving' : 'Save scores'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setRows((all) => [...all, { criterion: '', score: '' }])}
              disabled={pending || rows.length >= MAX_SCORE_ROWS}
            >
              Add criterion
            </Button>
            {rows.length > 1 ? (
              <Button
                variant="ghost"
                onClick={() => setRows((all) => all.slice(0, -1))}
                disabled={pending}
              >
                Remove last criterion
              </Button>
            ) : null}
            {rows.length >= MAX_SCORE_ROWS ? (
              <span className={styles.status}>Up to {MAX_SCORE_ROWS} criteria.</span>
            ) : null}
          </div>
        </div>
      </fieldset>
    </form>
  );
}

export interface QuotationChoice {
  id: string;
  /** The vendor and the platform's total, worded by the page. */
  label: string;
}

/**
 * Recommend one quotation. The reason for having fewer quotations than the company requires is
 * always on the form: the minimum is a setting the platform checks, so the form never guesses
 * whether it applies. On success the page reloads with the RFQ recommended and this form gone.
 */
export function RecommendForm({
  action,
  idempotencyKey,
  rfqId,
  choices,
  reloadHref,
}: {
  action: (prev: RfqFormState, form: FormData) => Promise<RfqFormState>;
  idempotencyKey: string;
  rfqId: string;
  choices: QuotationChoice[];
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RfqFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [values, setValues] = useState({
    vendorQuotationId: '',
    rationale: '',
    fewerThanThreeReason: '',
  });
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const set =
    (field: keyof typeof values) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));
  const err = state.errors;

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="rfqId" value={rfqId} />
      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'The recommendation was not saved'}
          actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}
      <div className={styles.grid}>
        <Field label="Quotation" error={err.vendorQuotationId} className={WIDE}>
          {(control) => (
            <Select
              name="vendorQuotationId"
              value={values.vendorQuotationId}
              onChange={set('vendorQuotationId')}
              required
              {...control}
            >
              <option value="">Choose the quotation to recommend</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Why this quotation"
          hint="Shown to the approvers with the recommendation."
          error={err.rationale}
          className={WIDE}
        >
          {(control) => (
            <Textarea
              name="rationale"
              value={values.rationale}
              onChange={set('rationale')}
              rows={3}
              maxLength={2000}
              required
              {...control}
            />
          )}
        </Field>
        <Field
          label="If fewer quotations than required"
          optional
          hint="Needed only below the company’s minimum number of quotations."
          help="Needed only when this RFQ has fewer quotations than the company’s minimum. Say why you are recommending anyway. Otherwise leave it empty."
          error={err.fewerThanThreeReason}
          className={WIDE}
        >
          {(control) => (
            <Textarea
              name="fewerThanThreeReason"
              value={values.fewerThanThreeReason}
              onChange={set('fewerThanThreeReason')}
              rows={2}
              maxLength={1000}
              {...control}
            />
          )}
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recommending' : 'Recommend this quotation'}
        </Button>
        {pending ? (
          <span role="status" className={styles.status}>
            Saving the recommendation
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Sends the recommended quotation to the commitment approvers, after one confirmation. The platform
 * refuses (422) when a step has nobody who may decide it, and nothing is submitted; its reason is
 * shown in the dialog as it wrote it. A success revalidates the page, which then no longer offers
 * this form, so the toast is raised where the result arrives rather than from an effect.
 */
export function CommitForm({
  action,
  idempotencyKey,
  rfqId,
  reloadHref,
}: {
  action: (prev: CommandState, form: FormData) => Promise<CommandState>;
  idempotencyKey: string;
  rfqId: string;
  reloadHref: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CommandState, FormData>(
    async (prev, form) => {
      const next = await action(prev, form);
      if (next.saved) {
        toast.success(next.saved);
        setOpen(false);
      }
      return next;
    },
    commandStart(idempotencyKey),
  );
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>Submit for commitment approval</Button>}
      title="Submit for commitment approval?"
      description="The Accountant, then Finance, then Management or the Founder when the amount is high decide it."
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
            {pending ? 'Submitting' : 'Submit'}
          </Button>
        </>
      }
    >
      <form noValidate id={formId} action={formAction} className={styles.panelForm}>
        <input type="hidden" name="rfqId" value={rfqId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {state.error ? (
          <Alert
            tone="error"
            role="alert"
            title={state.reload ? 'This page is out of date' : 'Not submitted'}
            actions={state.reload ? <a href={reloadHref}>Reload this RFQ</a> : null}
          >
            {state.error}
          </Alert>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * F1-Q47: moves an open RFQ's quotation deadline later, from a dialog in the page header. The new
 * deadline starts at the current one, in Kathmandu time, and must be later than it and than now;
 * once extended, invited vendors can send quotations again until the new deadline. A success
 * closes the dialog with a toast; the page revalidates with the new deadline.
 */
export function ExtendDeadlineForm({
  action,
  idempotencyKey,
  rfqId,
  deadline,
  deadlineText,
  passed,
  reloadHref,
}: {
  action: (prev: RfqEditState, form: FormData) => Promise<RfqEditState>;
  idempotencyKey: string;
  rfqId: string;
  /** The current deadline, an ISO instant. */
  deadline: string;
  /** The current deadline as the page shows it. */
  deadlineText: string;
  passed: boolean;
  reloadHref: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => isoToKathmanduLocal(deadline));
  const [state, formAction, pending] = useActionState<RfqEditState, FormData>(
    async (prev, form) => {
      const next = await action(prev, form);
      if (next.saved) {
        toast.success(next.saved);
        setOpen(false);
      }
      return next;
    },
    { key: idempotencyKey, errors: {}, count: 0 },
  );
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="secondary">Extend deadline</Button>}
      title="Extend the quotation deadline?"
      description={
        passed
          ? `The deadline passed on ${deadlineText}. Invited vendors can send quotations again until the new deadline.`
          : `Quotations close on ${deadlineText}. Invited vendors can send quotations until the new deadline.`
      }
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
            {pending ? 'Extending' : 'Extend deadline'}
          </Button>
        </>
      }
    >
      <form id={formId} action={formAction} noValidate className={styles.panelForm}>
        <input type="hidden" name="rfqId" value={rfqId} />
        <input type="hidden" name="currentDeadline" value={deadline} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {state.error ? (
          <Alert
            tone="error"
            role="alert"
            title={state.reload ? 'This page is out of date' : 'The deadline was not extended'}
            actions={state.reload ? <a href={reloadHref}>Reload this RFQ</a> : null}
          >
            {state.error}
          </Alert>
        ) : null}
        <Field
          label="New quotation deadline"
          hint="Kathmandu time. Later than the current deadline and than now."
          help="Kathmandu time. It must be later than the current deadline and later than now."
          error={state.errors.deadline}
        >
          {(control) => (
            <DateTimePicker
              {...control}
              name="deadline"
              value={value}
              onChange={setValue}
              required
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
