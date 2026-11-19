import type { ApprovalRequestDto } from '@bos/contracts';

import { Panel } from '@/components/ui/panel';
import { getApprovalRequest } from '@/lib/api-kernel';
import { when } from '@/lib/kernel-format';
import type { Session } from '@/lib/session';

import { ApprovalTimeline } from '../../procurement/approval-timeline';
import { approvalSummary } from '../../procurement/requests/_lib/model';

/**
 * The approval behind a bill or a payment request, read as this person through the approval's own read. A refused
 * or failed read gives null and the panel is left out: the record's link to the approval request still shows.
 */
export function loadApproval(
  session: Session,
  approvalRequestId: string | null,
): Promise<ApprovalRequestDto | null> {
  if (approvalRequestId === null) return Promise.resolve(null);
  return getApprovalRequest(session, approvalRequestId).catch(() => null);
}

/** The approval's steps, as on the procurement records. */
export function ApprovalHistory({ approval }: { approval: ApprovalRequestDto }) {
  return (
    <Panel
      title="Approval history"
      description={approvalSummary(
        approval.status,
        approval.decidedAt !== null ? when(approval.decidedAt) : null,
      )}
    >
      <ApprovalTimeline steps={approval.steps} />
    </Panel>
  );
}
