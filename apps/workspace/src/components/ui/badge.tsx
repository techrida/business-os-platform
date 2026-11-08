import type { HTMLAttributes } from 'react';

import styles from './badge.module.css';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** Figma status badge: a pill with the Badge/* colour pair for its tone. */
export function Badge({
  tone = 'neutral',
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  const cls = [styles.badge, styles[tone], className].filter(Boolean).join(' ');
  return <span className={cls} {...rest} />;
}
