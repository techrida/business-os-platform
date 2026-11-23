import { ROLE_KEYS } from '@bos/contracts';

import styles from './users.module.css';
import { Checkbox } from '@/components/ui/checkbox';

/** "customer_user" -> "Customer user". Display only: the checkbox value stays the role key. */
export function roleLabel(role: string): string {
  const text = role.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One checkbox per role, all named `roles`, so the Server Action reads them with getAll('roles').
 * Uncontrolled by default (`checked` is the starting selection). Pass `onToggle` to control it:
 * the caller then owns the selection, so a rejected save does not wipe what was ticked.
 */
export function RoleCheckboxes({
  idPrefix,
  legend,
  hideLegend = false,
  checked,
  onToggle,
}: {
  idPrefix: string;
  legend: string;
  /** Keep the legend for screen readers only, when a heading already says it. */
  hideLegend?: boolean;
  checked: readonly string[];
  onToggle?: (role: string, on: boolean) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={hideLegend ? 'sr-only' : styles.legend}>{legend}</legend>
      <div className={styles.checkGrid}>
        {ROLE_KEYS.map((role) => (
          <label key={role} className={styles.checkLabel} htmlFor={`${idPrefix}-${role}`}>
            <Checkbox
              id={`${idPrefix}-${role}`}
              name="roles"
              value={role}
              {...(onToggle
                ? {
                    checked: checked.includes(role),
                    onCheckedChange: (next: boolean) => onToggle(role, next),
                  }
                : { defaultChecked: checked.includes(role) })}
            />
            {roleLabel(role)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
