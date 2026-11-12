'use client';
import type { MemoDirectory, MemoTemplateSnapshot } from '@bos/contracts';
import { MemoPreview } from './memo-preview';
import { SignerSection } from './signer-section';
import { initialRecommenders, recommenderPayload } from './signer-rows';
import templateStyles from './memo-template.module.css';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

import styles from '../kit.module.css';
import type { MemoFormState, MemoValues } from './actions';

const CURRENCY_OPTIONS = [
  { value: 'NPR', label: 'NPR (Nepalese rupee)' },
  { value: 'INR', label: 'INR (Indian rupee)' },
  { value: 'USD', label: 'USD (US dollar)' },
];

/**
 * The memo create and edit form. One component for both, because they share fields and rules; the
 * server action passed in decides what happens on submit. Inputs are controlled so a refusal does
 * not wipe what was typed (React 19 resets uncontrolled fields after every action).
 */
export function MemoForm({
  action,
  initial,
  submitLabel,
  memoId,
  cancelHref,
  directory,
  template,
}: {
  action: (prev: MemoFormState, form: FormData) => Promise<MemoFormState>;
  initial: MemoValues;
  directory?: MemoDirectory | undefined;
  template?: MemoTemplateSnapshot | null | undefined;
  submitLabel: string;
  memoId?: string;
  /** Adds a Cancel link beside the submit button (the create page; the edit card has none). */
  cancelHref?: string;
}) {
  const [state, formAction, pending] = useActionState<MemoFormState, FormData>(action, {
    values: initial,
    fieldErrors: {},
  });
  const [values, setValues] = useState<MemoValues>(initial);
  const summaryRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof MemoValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  // Send focus to the first thing that needs fixing.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else if (state.fieldErrors.title) titleRef.current?.focus();
    else if (state.fieldErrors.amount) amountRef.current?.focus();
  }, [state]);

  const [departmentId, setDepartment] = useState(
    template?.departmentId ?? directory?.departmentId ?? '',
  );
  const [date, setDate] = useState(template?.date ?? new Date().toISOString().slice(0, 10));
  const [closing, setClosing] = useState(template?.closing ?? 'Submitted for your approval.');
  // A new memo starts with two blank "Recommended by" rows; an edit keeps exactly what was saved.
  const [recommenders, setRecommenders] = useState(() =>
    initialRecommenders(template?.recommenders.map((p) => p.userId)),
  );
  const [approvedBy, setApprovedBy] = useState(template?.approvedBy.userId ?? '');
  // Prepared by is always the signed-in author: the API refuses any other person for it.
  const preparedBy = directory?.currentUserId ?? template?.preparedBy.userId ?? '';
  // Blank rows are "not used yet": they never reach the preview or the API.
  const chosenRecommenders = recommenderPayload(recommenders);
  const person = (id: string) =>
    directory?.people.find((p) => p.userId === id) ?? {
      userId: id,
      name: '',
      jobTitle: null,
      department: null,
    };
  const preview = directory
    ? {
        organizationId: directory.organizationId,
        organizationName: template?.organizationName ?? directory.organizationName,
        departmentId,
        departmentName: directory.departments.find((d) => d.id === departmentId)?.name ?? '',
        date,
        closing,
        preparedBy: person(preparedBy),
        recommenders: chosenRecommenders.map(person),
        approvedBy: person(approvedBy),
      }
    : null;
  const templateInput = {
    departmentId,
    date,
    closing,
    preparedByUserId: preparedBy,
    recommenderUserIds: chosenRecommenders,
    approvedByUserId: approvedBy,
  };
  const err = state.fieldErrors;

  return (
    <div className={directory ? templateStyles.layout : undefined}>
      <form action={formAction} noValidate className={styles.form}>
        {directory ? (
          <>
            <input type="hidden" name="template" value={JSON.stringify(templateInput)} />
            <Field label="Department">
              {(control) => (
                <Select
                  {...control}
                  value={departmentId}
                  onChange={(e) => setDepartment(e.target.value)}
                  required
                >
                  <option value="">Choose department</option>
                  {directory.departments.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {directory.departments.length === 0 ? (
              <Alert tone="warning">
                Add a department to the company directory before creating a memo.
              </Alert>
            ) : null}
            <Field label="Date">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              )}
            </Field>
          </>
        ) : null}
        {memoId ? <input type="hidden" name="memoId" value={memoId} /> : null}

        {state.error ? (
          <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert">
            {state.error}
          </Alert>
        ) : null}

        <Field label={directory ? 'Subject' : 'Title'} error={err.title}>
          {(control) => (
            <Input
              ref={titleRef}
              name="title"
              value={values.title}
              onChange={set('title')}
              maxLength={200}
              required
              {...control}
            />
          )}
        </Field>

        <Field label={directory ? 'Body' : 'Details'} error={err.body}>
          {(control) => (
            <Textarea
              name="body"
              rows={6}
              value={values.body}
              onChange={set('body')}
              maxLength={10000}
              {...control}
            />
          )}
        </Field>

        {directory ? (
          <>
            <Field label="Closing">
              {(control) => (
                <Textarea
                  {...control}
                  value={closing}
                  onChange={(e) => setClosing(e.target.value)}
                  maxLength={1000}
                />
              )}
            </Field>
            <SignerSection
              people={directory.people}
              currentUserId={directory.currentUserId}
              recommenders={recommenders}
              onRecommenders={setRecommenders}
              approvedBy={approvedBy}
              onApprovedBy={setApprovedBy}
            />
          </>
        ) : null}
        <div className={styles.amountRow}>
          <Field
            label="Amount"
            hint="For example 1250.50. The NPR value is frozen when you save, using that day's rate."
            error={err.amount}
          >
            {(control) => (
              <Input
                ref={amountRef}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                value={values.amount}
                onChange={set('amount')}
                required
                className={styles.numeric}
                {...control}
              />
            )}
          </Field>

          <Field label="Currency" error={err.currency}>
            {(control) => (
              <Select
                name="currency"
                value={values.currency}
                onChange={set('currency')}
                {...control}
              >
                {CURRENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {!memoId ? (
          <p className={styles.note}>
            Attachments such as a PDF are added once the draft is saved. Choose{' '}
            <strong>Save and add attachments</strong> to go straight to the upload step.
          </p>
        ) : null}

        <div className={styles.formActions}>
          <Button type="submit" name="intent" value="save" disabled={pending}>
            {pending ? 'Saving' : submitLabel}
          </Button>
          {!memoId && directory ? (
            <Button
              type="submit"
              name="intent"
              value="attach"
              variant="secondary"
              disabled={pending}
            >
              Save and add attachments
            </Button>
          ) : null}
          {cancelHref ? (
            <LinkButton href={cancelHref} variant="secondary">
              Cancel
            </LinkButton>
          ) : null}
        </div>
      </form>
      {preview ? (
        <MemoPreview
          template={preview}
          title={values.title}
          body={values.body}
          source="current"
          sticky
          noun="preview"
        />
      ) : null}
    </div>
  );
}
