import { isPastDue } from '@/components/p2/crm/forms';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { when } from '@/lib/kernel-format';

import styles from './leads.module.css';

/**
 * The lead's owner with their avatar. Names come from the owners list and, for administrators, the
 * users directory; when neither knows the person the cell says so instead of showing an id.
 * `seedId` (the owner's user id) picks the initials colour and `imageDocumentId` their picture, so
 * the owner looks the same here as on every other screen.
 */
export function OwnerCell({
  owned,
  name,
  seedId,
  imageDocumentId,
}: {
  owned: boolean;
  name: string | undefined;
  seedId?: string | null;
  imageDocumentId?: string | null;
}) {
  if (!owned) return <span className={styles.quiet}>No owner</span>;
  if (!name) return <span className={styles.quiet}>Name unavailable</span>;
  return (
    <div className={styles.contact}>
      <Avatar
        name={name}
        seedId={seedId}
        imageDocumentId={imageDocumentId}
        shape="circle"
        aria-hidden="true"
      />
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
