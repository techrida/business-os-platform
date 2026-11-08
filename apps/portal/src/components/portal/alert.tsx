import type { ComponentPropsWithRef, ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
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

 * Copied from apps/workspace/src/components/ui/alert.tsx (dedupe later).
 *
 * Inline message strip (Figma Alert/*): a tinted box with a 1px border in the status colour and
 * an icon. The text stays in the primary text colour so it passes 4.5:1 on every tint; the tone
 * is carried by the icon and border, and the title or text names it in words.
 *
 * Pass `role="alert"` for something that must interrupt (a failed save) and `role="status"` for
 * a quiet confirmation. Leave `role` off for static text. It spreads its props, so a caller can
 * give it a `ref` and `tabIndex={-1}` to move focus to an error summary.
 */
export function Alert({ tone = 'info', title, actions, className, children, ...rest }: AlertProps) {
  const cls = [styles.alert, styles[tone], className].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      <Icon name={ICON[tone]} size={20} className={styles.icon} />
      <div className={styles.body}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <div className={styles.text}>{children}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
