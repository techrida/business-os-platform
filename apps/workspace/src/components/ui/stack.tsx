import type { HTMLAttributes } from 'react';

import styles from './stack.module.css';

type StackProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'main' | 'section';
  /** Space between children: 8, 16 or 24px. */
  gap?: 'small' | 'medium' | 'large';
};

/** Children in a column with an even gap. */
export function Stack({ as: Tag = 'div', gap = 'medium', className, ...rest }: StackProps) {
  const cls = [styles.stack, styles[gap], className].filter(Boolean).join(' ');
  return <Tag className={cls} {...rest} />;
}
