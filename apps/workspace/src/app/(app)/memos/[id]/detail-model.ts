import type { ApprovalStepDto } from '@bos/contracts';

import type { TimelineTone } from '@/components/ui/status-timeline';
import type { AttachmentView } from '@/lib/kernel-ui';

const MISSING_BY_STATUS: Record<string, string> = {
  quarantined: 'Scan running',
  awaiting_content: 'Scan running',
  infected: 'Virus found',
  rejected: 'File rejected',
};

/**
 * What still stops a memo from being submitted, as short pill labels: one per kind of problem, in the order the
 * files list them. Empty when every attachment is clean (or there are none). The API makes the same check when
 * Submit is pressed; this only tells the person early.
 */
export function submitMissing(files: readonly Pick<AttachmentView, 'status'>[]): string[] {
  const missing = new Set<string>();
  for (const file of files) {
    if (file.status === 'clean') continue;
    missing.add(MISSING_BY_STATUS[file.status] ?? 'Scan failed');
  }
  return [...missing];
}

const STAGE_TONE: Record<string, TimelineTone> = {
  waiting: 'upcoming',
  active: 'current',
  approved: 'done',
  returned: 'warning',
  rejected: 'error',
  skipped: 'muted',
};

const STAGE_STATUS: Record<string, string> = {
  waiting: 'Waiting',
  active: 'Pending',
  approved: 'Approved',
  returned: 'Returned',
  rejected: 'Rejected',
  skipped: 'Skipped',
};

export interface ApprovalStage {
  key: number;
  title: string;
  status: string;
  tone: TimelineTone;
  detail: string;
}

/**
 * The stages of a memo's approval route for the compact tracker under the page header, from the approval
 * request's steps. `signers` are the people the author named, in route order; without one a stage is named by its
 * assignee, role or group. A person's name that the directory cannot give is said so, never replaced by an id.
 */
export function approvalStages(
  steps: readonly ApprovalStepDto[],
  names: ReadonlyMap<string, string>,
  signers: readonly { name: string }[] = [],
): ApprovalStage[] {
  const person = (id: string) =>
    names.get(id) ?? names.get(id.toLowerCase()) ?? 'Approver name unavailable';
  const who = (step: ApprovalStepDto): string => {
    // The request's own assignee is what was frozen at submit; the template may have changed since.
    if (step.assigneeUserId) return person(step.assigneeUserId);
    if (step.kind === 'user' && step.userId && names.has(step.userId)) return person(step.userId);
    const named = signers[step.seq - 1]?.name;
    if (named) return named;
    if (step.kind === 'role' && step.roleKey) return `Anyone with the ${step.roleKey} role`;
    if (step.kind === 'group') return step.groupName ?? 'An approval group';
    if (step.kind === 'user' && step.userId) return person(step.userId);
    return `Step ${step.seq}`;
  };
  return [...steps]
    .sort((a, b) => a.seq - b.seq)
    .map((step) => {
      const decided = step.decidedBy
        ? `Decided by ${person(step.decidedBy)}${
            step.decidedOnBehalfOf ? ` for ${person(step.decidedOnBehalfOf)}` : ''
          }`
        : '';
      return {
        key: step.seq,
        title: who(step),
        status: STAGE_STATUS[step.status] ?? step.status,
        tone: STAGE_TONE[step.status] ?? 'upcoming',
        detail: [step.reason, decided].filter((part) => part !== '').join(' · '),
      };
    });
}
