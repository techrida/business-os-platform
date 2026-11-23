'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import styles from '@/app/(app)/activities/activities.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { ActivityTypeButtons, type ActivityTypeKind } from './activity-type-buttons';
import { LOG_ACTIVITY_KINDS } from './forms';
import type { FormAction, FormState } from './types';

const EMPTY: Record<string, string> = { subject: '', body: '' };
const DEFAULT_KIND: ActivityTypeKind = 'call';

/**
 * Log a call, meeting, email or note against one record (D39, D40). The type is a row of radio
 * buttons, Call first and selected; nothing here plans a follow-up (no due time), so a logged
 * activity goes straight to History. The record travels as two hidden inputs, so an activity can
 * never carry two subjects (the contract allows exactly one). A saved activity clears the form; a
 * refusal keeps what was typed and the chosen type.
 */
export function ActivityForm({
  action,
  subjectKind,
  subjectId,
}: {
  action: FormAction;
  /** `leadId` or `opportunityId`. */
  subjectKind: string;
  subjectId: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {
    values: EMPTY,
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(EMPTY);
  const [kind, setKind] = useState<ActivityTypeKind>(DEFAULT_KIND);
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
    if (state.ok) {
      setValues(EMPTY);
      setKind(DEFAULT_KIND);
    }
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

      <ActivityTypeButtons
        kinds={LOG_ACTIVITY_KINDS}
        value={kind}
        onChange={setKind}
        name="kind"
        label="Type"
        {...(err['kind'] ? { error: err['kind'] } : {})}
      />

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

      <Field label="Details" optional error={err['body']}>
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
