import { describe, expect, it } from 'vitest';

import type { ApprovalStepDto } from '@bos/contracts';

import { approvalStages, submitMissing } from './detail-model';

describe('submitMissing', () => {
  it('is empty with no attachments or only clean ones', () => {
    expect(submitMissing([])).toEqual([]);
    expect(submitMissing([{ status: 'clean' }])).toEqual([]);
  });

  it('names one pill per kind of problem, not per file', () => {
    expect(
      submitMissing([
        { status: 'quarantined' },
        { status: 'awaiting_content' },
        { status: 'clean' },
        { status: 'infected' },
        { status: 'rejected' },
        { status: 'something_new' },
      ]),
    ).toEqual(['Scan running', 'Virus found', 'File rejected', 'Scan failed']);
  });
});

const step = (over: Partial<ApprovalStepDto>): ApprovalStepDto => ({
  seq: 1,
  kind: 'user',
  roleKey: null,
  groupId: null,
  userId: null,
  reason: 'Approver named by the author',
  status: 'waiting',
  activatedAt: null,
  decidedBy: null,
  decidedOnBehalfOf: null,
  ...over,
});

describe('approvalStages', () => {
  const names = new Map([['u-1', 'Dev Founder']]);

  it('orders stages by sequence and maps each state to a tone and plain status', () => {
    const stages = approvalStages(
      [
        step({ seq: 2, status: 'waiting' }),
        step({ seq: 1, status: 'approved', decidedBy: 'u-1' }),
        step({ seq: 3, status: 'active' }),
        step({ seq: 4, status: 'rejected' }),
      ],
      names,
    );
    expect(stages.map((s) => [s.key, s.status, s.tone])).toEqual([
      [1, 'Approved', 'done'],
      [2, 'Waiting', 'upcoming'],
      [3, 'Pending', 'current'],
      [4, 'Rejected', 'error'],
    ]);
    expect(stages[0]?.detail).toBe('Approver named by the author · Decided by Dev Founder');
  });

  it('names a stage by the request, then the memo signer, then role or group', () => {
    const stages = approvalStages(
      [
        step({ seq: 1, userId: 'u-9' }),
        step({ seq: 2, kind: 'role', roleKey: 'finance' }),
        step({ seq: 3, kind: 'group', groupName: null }),
        step({ seq: 4, assigneeUserId: 'U-1' }),
      ],
      names,
      [{ name: 'Dev Management' }],
    );
    expect(stages.map((s) => s.title)).toEqual([
      'Dev Management',
      'Anyone with the finance role',
      'An approval group',
      'Dev Founder',
    ]);
  });

  it('names a step by the person the request froze, not by the signer now on the memo', () => {
    const [stage] = approvalStages([step({ seq: 1, userId: 'u-1' })], names, [
      { name: 'Someone added later' },
    ]);
    expect(stage?.title).toBe('Dev Founder');
  });

  it('never prints an id when the directory has no name', () => {
    const [stage] = approvalStages(
      [step({ userId: 'u-9', status: 'approved', decidedBy: 'u-9' })],
      names,
    );
    expect(stage?.title).toBe('Approver name unavailable');
    expect(stage?.detail).toContain('Decided by Approver name unavailable');
    expect(stage?.detail).not.toContain('u-9');
  });

  it('keeps an unknown state readable and upcoming, and says who a decision was for', () => {
    const [stage] = approvalStages(
      [step({ status: 'escalated' as never, decidedBy: 'u-1', decidedOnBehalfOf: 'u-1' })],
      names,
    );
    expect(stage).toMatchObject({ status: 'escalated', tone: 'upcoming' });
    expect(stage?.detail).toContain('Decided by Dev Founder for Dev Founder');
  });
});
