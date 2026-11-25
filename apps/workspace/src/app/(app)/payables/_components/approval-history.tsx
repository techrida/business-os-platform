import type { ApprovalRequestDto } from '@bos/contracts';

import { Alert } from '@/components/ui/alert';
import { Panel } from '@/components/ui/panel';
import { getApprovalRequest } from '@/lib/api-kernel';
import { ApiError } from '@/lib/api';
import { when } from '@/lib/kernel-format';
import type { Session } from '@/lib/session';

import { ApprovalActions } from '../../procurement/approval-actions';
import { ApprovalTimeline } from '../../procurement/approval-timeline';
import { approvalSummary } from '../../procurement/requests/_lib/model';

/** The read failed for a reason other than "not yours" or "not there": the page says so instead of going quiet. */
export const APPROVAL_LOAD_FAILED = 'failed' as const;
export type ApprovalLoad = ApprovalRequestDto | typeof APPROVAL_LOAD_FAILED;

/**
 * The approval behind a bill, a payment request, an invoice or an order, read as this person through the approval's own
 * read. A refusal (403) or a missing request (404) gives null and the panel is left out: the record's link to the
 * approval request still shows. Any other failure (a 5xx, the API away) gives APPROVAL_LOAD_FAILED, so the page shows an
 * error line where the history belongs rather than hiding a history that exists.
 */
export function loadApproval(
  session: Session,
  approvalRequestId: string | null,
): Promise<ApprovalLoad | null> {
  if (approvalRequestId === null) return Promise.resolve(null);
  return getApprovalRequest(session, approvalRequestId).catch((error: unknown) =>
    error instanceof ApiError && (error.status === 403 || error.status === 404)
      ? null
      : APPROVAL_LOAD_FAILED,
  );
}

/** The approval's steps, as on the procurement records. */
export function ApprovalHistory({ approval }: { approval: ApprovalLoad }) {
  if (approval === APPROVAL_LOAD_FAILED) {
    return (
      <Alert tone="error" role="alert" title="The approval history did not load">
        Reload the page to try again. The approval request itself is unchanged.
      </Alert>
    );
  }
  return (
    <Panel
      title="Approval history"
      description={approvalSummary(
        approval.status,
        approval.decidedAt !== null ? when(approval.decidedAt) : null,
      )}
    >
      <ApprovalTimeline steps={approval.steps} />
      <ApprovalActions actions={approval.actions} people={approval.people} />
    </Panel>
  );
}
