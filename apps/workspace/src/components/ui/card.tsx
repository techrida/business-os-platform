import type { HTMLAttributes } from 'react';

import styles from './card.module.css';

type CardProps = HTMLAttributes<HTMLElement> & {
  /** The element to render. Use `section` with a heading, `main` for a page that is one card. */
  as?: 'div' | 'section' | 'main' | 'article';
  tone?: 'default' | 'error';
};

/** White card on the pale page: 1px border, 12px radius. */
export function Card({ as: Tag = 'div', tone = 'default', className, ...rest }: CardProps) {
  const cls = [styles.card, tone === 'error' ? styles.error : undefined, className]
    .filter(Boolean)
    .join(' ');
  return <Tag className={cls} {...rest} />;
}
