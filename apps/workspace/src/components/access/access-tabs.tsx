'use client';

import { useSelectedLayoutSegment } from 'next/navigation';

import { TabNav } from '@/components/ui/tab-nav';

export const ACCESS_TABS = [
  { href: '/settings/access', label: 'By area' },
  { href: '/settings/access/roles', label: 'By role' },
  { href: '/settings/access/check', label: 'Check a person' },
] as const;

/** The tab whose route owns this segment of `/settings/access/...` (null is the By area page). */
export function activeAccessTab(segment: string | null): string {
  if (segment === 'roles') return '/settings/access/roles';
  if (segment === 'check') return '/settings/access/check';
  return '/settings/access';
}

/** The three Access tabs as links, so Back works and a tab can be shared (spec 2). */
export function AccessTabs() {
  const segment = useSelectedLayoutSegment();
  return <TabNav label="Access views" items={ACCESS_TABS} activeHref={activeAccessTab(segment)} />;
}
