import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

import { Card } from './card';
import styles from './panel.module.css';

/**
 * A card with a titled header: heading, optional description, optional actions on the right,
 * then the body. It is a landmark named by its heading (`section`, or `aside` for a side card),
 * so screen readers can jump to it. One heading per panel, `h2` by default.
 */
export function Panel({
  title,
  description,
  actions,
  as = 'section',
  headingLevel = 2,
  children,
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'section' | 'aside';
  headingLevel?: 2 | 3;
  children?: ReactNode;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const cls = [styles.panel, className].filter(Boolean).join(' ');
  return (
    <Card as={as} aria-labelledby={headingId} className={cls} {...rest}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <Heading id={headingId} className={styles.title}>
            {title}
          </Heading>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {children}
    </Card>
  );
}

export interface Fact {
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** Takes the whole row: for long text and pre-formatted blocks. */
  wide?: boolean | undefined;
}

/**
 * Label / value grid (Figma "Lead Overview" 727:10692): each fact is a small grey label over
 * its value, in as many columns as fit. A `<dl>`, so the pairs are announced as pairs.
 */
export function FactList({ facts, className }: { facts: readonly Fact[]; className?: string }) {
  const cls = [styles.facts, className].filter(Boolean).join(' ');
  return (
    <dl className={cls}>
      {facts.map((fact) => (
        <div key={fact.key} className={fact.wide ? `${styles.fact} ${styles.wide}` : styles.fact}>
          <dt className={styles.term}>{fact.label}</dt>
          <dd className={styles.value}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A grey placeholder block for loading states. Hidden from assistive technology. */
export function Skeleton({
  height = 16,
  width = '100%',
  className,
}: {
  height?: number;
  width?: number | string;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={[styles.skeleton, className].filter(Boolean).join(' ')}
      style={{ height, width }}
    />
  );
}
