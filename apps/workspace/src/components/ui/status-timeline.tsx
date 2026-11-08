import type { ReactNode } from 'react';

import styles from './status-timeline.module.css';

export type TimelineTone = 'done' | 'current' | 'upcoming' | 'warning' | 'error' | 'muted';

export interface TimelineStep {
  key: string | number;
  /** Who or what the step is, for example "Anyone with the finance role". */
  title: ReactNode;
  /** The step's state in words ("Approved", "Waiting for a decision"). Colour alone never says it. */
  status: string;
  tone: TimelineTone;
  /** A caption under the status: a date, who decided. */
  detail?: ReactNode;
}

/**
 * Horizontal step timeline (Figma status timeline 727:10665): one segment per step with a 4px bar
 * on top coloured by its state, the step title, its state in words and an optional caption. The
 * segments wrap onto more rows on narrow screens. It is an ordered list named by `label`, and the
 * active step carries `aria-current="step"`.
 */
export function StatusTimeline({
  label,
  steps,
  className,
}: {
  label: string;
  steps: readonly TimelineStep[];
  className?: string;
}) {
  const cls = [styles.list, className].filter(Boolean).join(' ');
  return (
    <ol className={cls} aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.key}
          className={`${styles.step} ${styles[step.tone]}`}
          {...(step.tone === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span className={styles.bar} aria-hidden="true" />
          <span className={styles.title}>
            <span className="sr-only">Step {index + 1}: </span>
            {step.title}
          </span>
          <span className={styles.status}>{step.status}</span>
          {step.detail ? <span className={styles.detail}>{step.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
