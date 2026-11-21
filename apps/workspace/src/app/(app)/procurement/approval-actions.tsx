import type { ApprovalRequestDto } from '@bos/contracts';

import { when } from '@/lib/kernel-format';

import styles from './approval-actions.module.css';

const ACTION_LABEL: Record<string, string> = {
  submit: 'Submitted',
  approve: 'Approved',
  return: 'Returned for changes',
  reject: 'Rejected',
  escalate: 'Escalated after the deadline',
  remind: 'Reminder sent',
  block: 'Blocked: no approver available',
  reroute: 'Route recalculated',
  cancel: 'Withdrawn',
};

/**
 * The dated record of an approval: each action in the order it happened, with its date and who acted (and for whom,
 * when they acted as a delegate). Everything comes from the approval's own read (`actions` and `people`); a person
 * the read did not name shows as "Person name unavailable", never as an id. Nothing is drawn before the first action.
 */
export function ApprovalActions({
  actions,
  people,
}: {
  actions: ApprovalRequestDto['actions'] | undefined;
  people: ApprovalRequestDto['people'];
}) {
  if (actions === undefined || actions.length === 0) return null;
  const names = new Map((people ?? []).map((p) => [p.userId.toLowerCase(), p.name] as const));
  const who = (id: string): string => names.get(id.toLowerCase()) ?? 'Person name unavailable';
  return (
    <section className={styles.wrap} aria-labelledby="approval-actions-title">
      <h3 id="approval-actions-title" className={styles.title}>
        Who acted
      </h3>
      <ol className={styles.list}>
        {actions.map((a, i) => (
          <li key={`${a.createdAt}-${i}`} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.name}>{ACTION_LABEL[a.action] ?? a.action}</span>
              <span className={styles.meta}>
                {a.actorUserId === 'system' ? 'automatically' : `by ${who(a.actorUserId)}`}
                {a.onBehalfOfUserId ? ` for ${who(a.onBehalfOfUserId)}` : ''}
              </span>
              <time className={styles.meta} dateTime={a.createdAt}>
                {when(a.createdAt)}
              </time>
            </div>
            {a.comment ? <p className={styles.comment}>{a.comment}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
