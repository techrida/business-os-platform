import type { ComponentPropsWithRef, ReactNode } from 'react';

import { Icon, type IconName } from './icon';
import styles from './alert.module.css';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

const ICON: Record<AlertTone, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  error: 'x-circle',
};

type AlertProps = Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  tone?: AlertTone;
  /** A bold first line. Put the detail in `children`. */
  title?: ReactNode;
  /** Links or buttons, shown under the text. */
  actions?: ReactNode;
};

/**
 * Inline message strip (Figma Alert/*): a tinted box with a thin neutral border and a status icon.
 * The text uses the primary text colour for contrast, and the title or text names the state.
 *
 * Pass `role="alert"` for something that must interrupt (a failed save) and `role="status"` for
 * a quiet confirmation. Leave `role` off for static text. It spreads its props, so a caller can
 * give it a `ref` and `tabIndex={-1}` to move focus to an error summary.
 */
export function Alert({ tone = 'info', title, actions, className, children, ...rest }: AlertProps) {
  const cls = [styles.alert, styles[tone], className].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      <Icon name={ICON[tone]} size={16} className={styles.icon} />
      <div className={styles.body}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <div className={styles.text}>{children}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
