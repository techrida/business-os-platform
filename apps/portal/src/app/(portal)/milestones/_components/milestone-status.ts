import type { PortalMilestoneStatus } from '@bos/contracts';

type Tone = 'neutral' | 'info' | 'success';

/** How a milestone's status reads to the customer. The server decides the status; this only names it. */
export const MILESTONE_LOOK: Record<PortalMilestoneStatus, { label: string; tone: Tone }> = {
  upcoming: { label: 'Upcoming', tone: 'neutral' },
  reached: { label: 'Reached', tone: 'info' },
  invoiced: { label: 'Invoiced', tone: 'success' },
};

/** "2 of 3 invoiced": how far an order's billing has come, for the order list. */
export function invoicedCount(milestones: readonly { status: PortalMilestoneStatus }[]): string {
  const done = milestones.filter((m) => m.status === 'invoiced').length;
  return `${done} of ${milestones.length} invoiced`;
}
