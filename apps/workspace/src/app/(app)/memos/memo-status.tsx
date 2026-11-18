import { Badge } from '@/components/ui/badge';

const STATUS = {
  draft: ['Draft', 'neutral'],
  submitted: ['Submitted', 'pending'],
  approved: ['Approved', 'success'],
  returned: ['Returned', 'warning'],
  rejected: ['Rejected', 'error'],
} as const;

export function MemoStatus({ status }: { status: keyof typeof STATUS }) {
  const [label, tone] = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}
