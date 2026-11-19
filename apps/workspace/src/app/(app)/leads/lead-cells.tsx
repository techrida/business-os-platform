import { isPastDue } from '@/components/p2/crm/forms';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { when } from '@/lib/kernel-format';

import styles from './leads.module.css';

/**
 * The lead's owner with initials. The name is the display name the API joins onto the lead (D46), so every
 * role that can read the lead sees it; null means the lead has no owner.
 */
export function OwnerCell({ name }: { name: string | null }) {
  if (name === null) return <span className={styles.quiet}>No owner</span>;
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
