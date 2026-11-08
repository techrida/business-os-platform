import type { ReactNode } from 'react';

import { Icon, type IconName } from './icon';
import styles from './empty-state.module.css';

/**
 * "Nothing here yet" block (Figma Empty-State tokens): an icon, a title that says what is empty,
 * one line on what to do or when it fills, and an optional action. The title is a heading so a
 * screen reader user can jump to it; pass `headingLevel` to fit the page's outline.
 */
export function EmptyState({
  title,
  children,
  icon = 'inbox',
  action,
  headingLevel = 2,
  className,
}: {
  title: string;
  children?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const cls = [styles.empty, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className={styles.icon}>
        <Icon name={icon} size={24} />
      </span>
      <Heading className={styles.title}>{title}</Heading>
      {children ? <p className={styles.text}>{children}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
