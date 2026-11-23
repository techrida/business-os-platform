'use client';
// Small pieces of the convert wizard: the step indicator, and the box that carries a search icon inside on the right.

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
