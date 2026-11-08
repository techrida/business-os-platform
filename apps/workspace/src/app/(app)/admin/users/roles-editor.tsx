'use client';

import { useActionState } from 'react';

import styles from '../admin.module.css';
import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { setRolesAction } from './actions';
import { RoleCheckboxes } from './role-checkboxes';

/** Edit one user's roles inline. The label names the person so each "Edit roles" is distinct. */
export function RolesEditor({
  userId,
  label,
  roles,
}: {
  userId: string;
  label: string;
  roles: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(setRolesAction, IDLE);
  return (
    <details className={styles.inlineDetails}>
      <summary>
        Edit roles<span className={styles.srOnly}> for {label}</span>
      </summary>
      <form action={formAction} className={styles.stack}>
        <input type="hidden" name="userId" value={userId} />
        <RoleCheckboxes
          idPrefix={`roles-${userId}`}
          legend={`Roles for ${label}`}
          checked={roles}
        />
        <div className={styles.actions}>
          <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={pending}>
            Save roles
          </button>
          <FormStatus state={state} pending={pending} />
        </div>
      </form>
    </details>
  );
}
