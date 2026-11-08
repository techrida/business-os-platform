'use client';

import { useActionState } from 'react';

import styles from '../admin.module.css';
import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { inviteUserAction } from './actions';
import { RoleCheckboxes } from './role-checkboxes';

// A Client Component for useActionState only: it shows the result next to the button without a
// page reload. The write itself is the Server Action.
export function InviteForm() {
  const [state, formAction, pending] = useActionState(inviteUserAction, IDLE);
  const fields = state.fields ?? {};
  // On success the form clears (React resets it); on an error `fields` puts the values back.
  const kept = state.status === 'error' ? fields : {};

  return (
    <form action={formAction} className={styles.form}>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            className={styles.input}
            type="email"
            name="email"
            autoComplete="off"
            required
            defaultValue={kept.email ?? ''}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="invite-given">Given name</label>
          <input
            id="invite-given"
            className={styles.input}
            name="givenName"
            autoComplete="off"
            required
            defaultValue={kept.givenName ?? ''}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="invite-family">Family name</label>
          <input
            id="invite-family"
            className={styles.input}
            name="familyName"
            autoComplete="off"
            required
            defaultValue={kept.familyName ?? ''}
          />
        </div>
      </div>
      <RoleCheckboxes
        idPrefix="invite-role"
        legend="Roles"
        checked={(kept.roles ?? '').split(',').filter(Boolean)}
      />
      <p className={styles.hint}>
        The person gets an email with a link to set up their sign-in. Roles can be changed later.
      </p>
      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          Send invitation
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}
