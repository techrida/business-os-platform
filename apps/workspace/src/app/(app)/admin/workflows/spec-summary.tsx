import { WorkflowSpecSchema } from '@bos/contracts';

import { describeCondition, describeStepTarget } from './spec-form';
import styles from './workflows.module.css';

/**
 * A read-only description of a spec: used for published and retired versions, which can never be
 * edited (the database refuses it). A spec that no longer matches the current schema falls back to
 * its raw JSON, so nothing is hidden.
 */
export function SpecSummary({ spec }: { spec: unknown }) {
  const parsed = WorkflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    // Scrollable, so it must be reachable by keyboard.
    return (
      <pre className={styles.pre} tabIndex={0}>
        {JSON.stringify(spec, null, 2)}
      </pre>
    );
  }
  const s = parsed.data;
  return (
    <div className={styles.specStack}>
      <div>
        <h4 className={styles.specHeading}>Steps</h4>
        <ol className={styles.steps}>
          {s.steps.map((step) => (
            <li key={step.id}>
              <span className={styles.mono}>{describeStepTarget(step)}</span>
              <span className={styles.muted}> - {step.reason}</span>
            </li>
          ))}
        </ol>
      </div>
      {s.rules.length > 0 ? (
        <div>
          <h4 className={styles.specHeading}>Rules</h4>
          <ul className={styles.steps}>
            {s.rules.map((rule) => (
              <li key={rule.id}>
                When <span className={styles.mono}>{describeCondition(rule.when)}</span>, add{' '}
                <span className={styles.mono}>{describeStepTarget(rule.add)}</span>{' '}
                {rule.position === 'end' ? 'at the end' : `after ${rule.position.after}`}
                <span className={styles.muted}> - {rule.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={styles.hint}>
        {s.distinctApprovers
          ? 'One person cannot approve two steps of the same request.'
          : 'The same person may approve more than one step.'}{' '}
        Reminder after {s.sla.remindAfterHours} h, escalation to {s.sla.escalateTo.role} after{' '}
        {s.sla.escalateAfterHours} h.
      </p>
    </div>
  );
}
