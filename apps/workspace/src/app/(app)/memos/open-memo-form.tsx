'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

import styles from '../kit.module.css';
import { openMemoAction, type OpenState } from './actions';

/** Opens a memo by id. A stopgap until the API has a list route; see the memos page. */
export function OpenMemoForm() {
  const [state, formAction, pending] = useActionState<OpenState, FormData>(openMemoAction, {});
  return (
    <form action={formAction} noValidate className={styles.form}>
      <Field
        label="Memo id"
        error={state.error ? <span role="alert">{state.error}</span> : undefined}
      >
        {(control) => (
          <Input
            name="memoId"
            className={styles.mono}
            autoComplete="off"
            spellCheck={false}
            {...control}
          />
        )}
      </Field>
      <div className={styles.formActions}>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Opening' : 'Open memo'}
        </Button>
      </div>
    </form>
  );
}
