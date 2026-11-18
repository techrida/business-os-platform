import type { HTMLAttributes } from 'react';

import styles from './badge.module.css';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'pending' | 'error' | 'disabled';

/**
 * Figma status badge (node set 469:13451). Tones map to the Figma `status` prop: success is
 * Success, warning is Pending, error is error, info is info, disabled is disabled. `neutral`
 * is ours: a readable grey for plain labels such as a role name. The `disabled` tone is the
 * Figma one (slate-400 on slate-100), which is for inactive things only and is too faint for
 * text that has to be read.
 */
export function Badge({
  tone = 'neutral',
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  const cls = [styles.badge, styles[tone === 'pending' ? 'warning' : tone], className]
    .filter(Boolean)
    .join(' ');
  return <span className={cls} {...rest} />;
}
