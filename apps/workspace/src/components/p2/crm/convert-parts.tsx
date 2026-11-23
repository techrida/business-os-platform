'use client';
// Small pieces of the convert wizard: the step indicator, the right-hand "Optional" mark of a label row, and the box
// that carries a search icon inside on the right.
import type { ReactNode } from 'react';

import { Icon } from '@/components/ui/icon';

import { CONVERT_STEPS, type ConvertStep } from './convert-model';
import styles from './convert-dialog.module.css';

export function StepIndicator({ step }: { step: ConvertStep }) {
  return (
    <ol className={styles.steps} aria-label="Conversion steps">
      {CONVERT_STEPS.map((label, index) => (
        <li
          key={label}
          className={styles.step}
          data-state={index < step ? 'done' : index === step ? 'current' : 'todo'}
          aria-current={index === step ? 'step' : undefined}
        >
          <span className={styles.stepNumber} aria-hidden="true">
            {index + 1}
          </span>
          <span className={styles.stepLabel}>
            <span className="sr-only">Step {index + 1} of 3: </span>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A field label with a muted "Optional" at the right end of the row; nothing under the box (UIP-FORM-008). */
export function OptionalLabel({ children }: { children: ReactNode }) {
  return (
    <span className={styles.labelRow}>
      <span>{children}</span>
      <span className={styles.optional}>Optional</span>
    </span>
  );
}

/** Wraps a searching combobox with the search icon inside, on the right (UIP-FORM-009). */
export function SearchBox({ children }: { children: ReactNode }) {
  return (
    <div className={styles.searchBox}>
      {children}
      <Icon name="search" size={20} className={styles.searchIcon} />
    </div>
  );
}
