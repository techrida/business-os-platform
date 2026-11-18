import type { InvoiceDto, InvoiceStatus } from '@bos/contracts';

import { StatusTimeline, type TimelineStep } from '@/components/ui/status-timeline';

const STAGES = [
  { key: 'draft', title: 'Draft', label: 'Prepared' },
  { key: 'submitted', title: 'Approval', label: 'Reviewed' },
  { key: 'approved', title: 'Ready to issue', label: 'Approved' },
  { key: 'issued', title: 'Issue', label: 'Issued' },
] as const;
const STATE: Record<Exclude<InvoiceStatus, 'discarded'>, string> = {
  draft: 'In progress',
  submitted: 'Pending',
  approved: 'Ready',
  issued: 'Issued',
  returned: 'Returned',
};

export function InvoiceProgress({ invoice }: { invoice: Pick<InvoiceDto, 'kind' | 'status'> }) {
  const { kind, status } = invoice;
  if (status === 'discarded') return null;
  const stages =
    kind === 'proforma' ? STAGES.filter(({ key }) => key === 'draft' || key === 'issued') : STAGES;
  const current = stages.findIndex(
    ({ key }) => key === (status === 'returned' ? 'submitted' : status),
  );
  const steps: TimelineStep[] = stages.map(({ key, title, label }, index) => {
    const reached = index === current;
    return {
      key,
      title,
      status: reached ? STATE[status] : index < current ? label : 'Upcoming',
      tone: reached
        ? status === 'returned'
          ? 'warning'
          : 'current'
        : index < current
          ? 'done'
          : 'upcoming',
    };
  });

  return <StatusTimeline label="Invoice progress" steps={steps} />;
}
