'use client';

import { StatCard } from '@/components/ui/stat-card';
import { useShellCounts } from '@/components/shell/shell-counts';

/**
 * The home page's unread-notifications card. The number is the shell's own live count (the same one the
 * bell shows), so the page makes no read of its own. Until the count is known the card is left out, never a zero.
 */
export function UnreadStat() {
  const unread = useShellCounts()?.notifications;
  if (unread === undefined) return null;
  return <StatCard label="Unread notifications" value={unread} icon="bell" />;
}
