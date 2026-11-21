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
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  // A comment the engine wrote itself can carry a user id ("Step 2 (user <id>)"): show the name, never the id.
  const readable = (comment: string): string =>
    comment.replace(UUID, (id) => names.get(id.toLowerCase()) ?? 'an approver');
  // The engine writes these itself, so no one is named as having acted.
  const automatic = (a: { action: string; actorUserId: string }): boolean =>
    a.actorUserId === 'system' || a.action === 'block';
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
                {automatic(a) ? 'automatically' : `by ${who(a.actorUserId)}`}
                {a.onBehalfOfUserId ? ` for ${who(a.onBehalfOfUserId)}` : ''}
              </span>
              <time className={styles.meta} dateTime={a.createdAt}>
                {when(a.createdAt)}
              </time>
            </div>
            {a.comment ? <p className={styles.comment}>{readable(a.comment)}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
