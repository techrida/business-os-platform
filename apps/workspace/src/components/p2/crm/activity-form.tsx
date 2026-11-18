'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import styles from '@/app/(app)/activities/activities.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import type { FormAction, FormState } from './types';

const EMPTY: Record<string, string> = { kind: 'call', subject: '', body: '', dueAt: '' };

/**
 * Log a call, meeting, email, note or task against one record. The record travels as two hidden
 * inputs, so an activity can never carry two subjects (the contract allows exactly one). A saved
 * activity clears the form; a refusal keeps what was typed.
 */
export function ActivityForm({
  action,
  kinds,
  subjectKind,
  subjectId,
}: {
  action: FormAction;
  kinds: { value: string; label: string }[];
  /** `leadId` or `opportunityId`. */
  subjectKind: string;
  subjectId: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {
    values: EMPTY,
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(EMPTY);
  const summary = useRef<HTMLDivElement>(null);
  // Made on the first submit (not on render, so server and browser HTML agree). After that the
  // action hands back the key to use: the same one when the outcome is unknown, a new one after a
  // save or a refusal.
  const firstKey = useRef<string | null>(null);
  const submit = (data: FormData) => {
    data.set('idempotencyKey', state.key ?? (firstKey.current ??= crypto.randomUUID()));
    formAction(data);
  };
  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const err = state.fieldErrors;

  // A saved activity clears the form (adjusting state while rendering, not in an effect).
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.ok) setValues(EMPTY);
  }
  useEffect(() => {
    if (state.error) summary.current?.focus();
    if (state.ok) toast.success('Activity logged.');
  }, [state]);

  return (
    <form action={submit} noValidate className={styles.activityForm}>
      <input type="hidden" name="subjectKind" value={subjectKind} />
      <input type="hidden" name="subjectId" value={subjectId} />

      {state.error ? (
        <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <Field label="What it was about" error={err['subject']}>
        {(c) => (
          <Input
            name="subject"
            value={values['subject']}
            onChange={set('subject')}
            maxLength={200}
            required
            {...c}
          />
        )}
      </Field>

      <div className={styles.activityFields}>
        <Field label="Type" error={err['kind']}>
          {(c) => (
            <Select name="kind" value={values['kind']} onChange={set('kind')} {...c}>
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {values['kind'] === 'task' ? (
          <Field label="Due" hint="Kathmandu time. Optional." error={err['dueAt']}>
            {(c) => (
              <Input
                name="dueAt"
                type="datetime-local"
                value={values['dueAt']}
                onChange={set('dueAt')}
                {...c}
              />
            )}
          </Field>
        ) : null}
      </div>

      <Field label="Details" hint="Optional." error={err['body']}>
        {(c) => (
          <Textarea
            name="body"
            rows={3}
            value={values['body']}
            onChange={set('body')}
            maxLength={10000}
            {...c}
          />
        )}
      </Field>

      <div className={styles.formFooter}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Log activity'}
        </Button>
      </div>
    </form>
  );
}
