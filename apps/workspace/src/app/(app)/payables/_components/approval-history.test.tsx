import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

const mocks = vi.hoisted(() => ({ getApprovalRequest: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api-kernel', () => ({ getApprovalRequest: mocks.getApprovalRequest }));
vi.mock('../../procurement/approval-actions', () => ({ ApprovalActions: () => null }));
vi.mock('../../procurement/approval-timeline', () => ({ ApprovalTimeline: () => null }));

import { ApiError } from '@/lib/api';

import { APPROVAL_LOAD_FAILED, ApprovalHistory, loadApproval } from './approval-history';

const session = {} as Session;

describe('loadApproval (R6Q24)', () => {
  beforeEach(() => {
    mocks.getApprovalRequest.mockReset();
  });

  it('gives null for a record with no approval request, without reading', async () => {
    expect(await loadApproval(session, null)).toBeNull();
    expect(mocks.getApprovalRequest).not.toHaveBeenCalled();
  });

  it.each([403, 404])('leaves the panel out when the read answers %i', async (status) => {
    mocks.getApprovalRequest.mockImplementation(() =>
      Promise.reject(new ApiError(status, 'refused')),
    );
    expect(await loadApproval(session, 'a1')).toBeNull();
  });

  it.each([500, 502, 503])('flags a failed read when the API answers %i', async (status) => {
    mocks.getApprovalRequest.mockImplementation(() => Promise.reject(new ApiError(status, 'down')));
    expect(await loadApproval(session, 'a1')).toBe(APPROVAL_LOAD_FAILED);
  });

  it('flags a failed read when the API cannot be reached at all', async () => {
    mocks.getApprovalRequest.mockImplementation(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(await loadApproval(session, 'a1')).toBe(APPROVAL_LOAD_FAILED);
  });

  it('returns the approval when the read works', async () => {
    const approval = {
      id: 'a1',
      status: 'approved',
      decidedAt: null,
      steps: [],
      actions: [],
      people: [],
    };
    mocks.getApprovalRequest.mockResolvedValue(approval);
    expect(await loadApproval(session, 'a1')).toBe(approval);
  });
});

describe('ApprovalHistory when the read failed (R6Q24)', () => {
  it('shows an error line instead of nothing', () => {
    const html = renderToStaticMarkup(<ApprovalHistory approval={APPROVAL_LOAD_FAILED} />);
    expect(html).toContain('The approval history did not load');
    expect(html).toContain('role="alert"');
  });
});
