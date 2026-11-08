import { ROLE_KEYS } from '@bos/contracts';

import styles from '../admin.module.css';

/** One checkbox per role, all named `roles`, so the Server Action reads them with getAll('roles'). */
export function RoleCheckboxes({
  idPrefix,
  legend,
  checked,
}: {
  idPrefix: string;
  legend: string;
  checked: readonly string[];
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.checkGrid}>
        {ROLE_KEYS.map((role) => (
          <label key={role} className={styles.checkLabel} htmlFor={`${idPrefix}-${role}`}>
            <input
              id={`${idPrefix}-${role}`}
              className={styles.checkbox}
              type="checkbox"
              name="roles"
              value={role}
              defaultChecked={checked.includes(role)}
            />
            {role}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
