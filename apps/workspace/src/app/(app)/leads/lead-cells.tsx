import { isPastDue } from '@/components/p2/crm/forms';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { when } from '@/lib/kernel-format';

import styles from './leads.module.css';

/**
 * The lead's owner with initials. Names come from the owners list and, for administrators, the
 * users directory; when neither knows the person the cell says so instead of showing an id.
 */
export function OwnerCell({ owned, name }: { owned: boolean; name: string | undefined }) {
  if (!owned) return <span className={styles.quiet}>No owner</span>;
  if (!name) return <span className={styles.quiet}>Name unavailable</span>;
  return (
    <div className={styles.contact}>
      <Avatar name={name} shape="circle" aria-hidden="true" />
      <span>{name}</span>
    </div>
  );
}

/**
 * The earliest planned follow-up (`LeadDto.nextFollowUpAt`, derived by the API). Past due reads
 * "Overdue" in the warning tone, so the state does not depend on colour alone.
 */
export function NextFollowUpCell({ at, now = new Date() }: { at: string | null; now?: Date }) {
  if (!at) return <span className={styles.quiet}>None planned</span>;
  const date = (
    <time dateTime={at} title={when(at)}>
      {when(at, 'date')}
    </time>
  );
  if (!isPastDue(at, now)) return date;
  return (
    <span className={styles.followUp}>
      <Badge tone="warning">Overdue</Badge>
      {date}
    </span>
  );
}
