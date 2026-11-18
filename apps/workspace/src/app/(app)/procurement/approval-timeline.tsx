import type { ApprovalRequestDto } from '@bos/contracts';

import { StatusTimeline, type TimelineTone } from '@/components/ui/status-timeline';
import { humanizeKey } from '@/lib/kernel-ui';

const TONE: Record<string, TimelineTone> = {
  approved: 'done',
  rejected: 'error',
  returned: 'warning',
  active: 'current',
  pending: 'upcoming',
};

export function ApprovalTimeline({ steps }: { steps: ApprovalRequestDto['steps'] }) {
  return (
    <StatusTimeline
      label="Approval steps"
      steps={steps.map((step) => ({
        key: step.seq,
        title: step.reason,
        status: humanizeKey(step.status),
        tone: TONE[step.status] ?? 'muted',
      }))}
    />
  );
}
