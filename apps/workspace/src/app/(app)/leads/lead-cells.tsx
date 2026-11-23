import { isPastDue } from '@/components/p2/crm/forms';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { when } from '@/lib/kernel-format';

import styles from './leads.module.css';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * The lead's owner with initials. The name is the display name the API joins onto the lead (D46), so every
 * role that can read the lead sees it; null means the lead has no owner. `seedId` (the owner's user id) picks the
 * initials colour and `imageDocumentId` their picture, so the owner looks the same here as on every other screen.
 */
export function OwnerCell({
  name,
  seedId,
  imageDocumentId,
}: {
  name: string | null;
  seedId?: string | null;
  imageDocumentId?: string | null;
}) {
  if (name === null) return <span className={styles.quiet}>No owner</span>;
  return (
    <div className={styles.contact}>
      <Avatar
        name={name}
        seedId={seedId ?? null}
        imageDocumentId={imageDocumentId ?? null}
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
    <Tooltip content={when(at)}>
      <time dateTime={at}>{when(at, 'date')}</time>
    </Tooltip>
  );
  if (!isPastDue(at, now)) return date;
  return (
    <span className={styles.followUp}>
      <Badge tone="warning">Overdue</Badge>
      {date}
    </span>
  );
}
