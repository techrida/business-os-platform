import { type Permission, RFQ_STATUSES } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { permissionsFrom } from '@/lib/live-permissions';

import {
  arrivedLate,
  canCommit,
  canExtendDeadline,
  canStartRfq,
  deadlinePassed,
  RFQ_STATUS_LABEL,
  RFQ_STATUS_NOTE,
  rfqGrants,
  submissionConvertibility,
  takesDecisions,
} from './model';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ getMe: vi.fn() }));

/** The predicate `getPermissionCheck` builds from a `/v1/me` grant list (null: the read failed). */
function live(roles: string[], granted: Permission[] | null): (permission: string) => boolean {
  const held = new Set(
    permissionsFrom(
      granted === null
        ? null
        : { permissions: granted.map((permission) => ({ permission, scope: 'all' as const })) },
      roles,
    ),
  );
  return (permission) => held.has(permission);
}

const SOURCING = live(['procurement'], ['procurement.sourcing']);
const NONE = live(['sales'], []);

describe('labels', () => {
  it('every RFQ status has a label and a note', () => {
    for (const s of RFQ_STATUSES) {
      expect(RFQ_STATUS_LABEL[s].text).not.toBe('');
      expect(RFQ_STATUS_NOTE[s]).not.toBe('');
    }
  });
});

describe('rfqGrants', () => {
  it('follows the live grant: sourcing may source; a plain requester may not', () => {
    expect(rfqGrants(SOURCING).sourcing).toBe(true);
    expect(rfqGrants(NONE).sourcing).toBe(false);
  });

  it('follows saved grants, not role defaults', () => {
    // Sales holds no sourcing by default; a saved grant gives it.
    expect(rfqGrants(live(['sales'], ['procurement.sourcing'])).sourcing).toBe(true);
    // Procurement holds sourcing by default; a saved role without it takes it away.
    expect(rfqGrants(live(['procurement'], ['procurement.pr.read'])).sourcing).toBe(false);
  });

  it('falls back to role defaults only when /v1/me fails', () => {
    expect(rfqGrants(live(['procurement'], null)).sourcing).toBe(true);
    expect(rfqGrants(live(['sales'], null)).sourcing).toBe(false);
  });
});

describe('canStartRfq', () => {
  it('needs a department-approved request with no RFQ and the sourcing grant', () => {
    expect(canStartRfq('dept_approved', null, SOURCING)).toBe(true);
    expect(canStartRfq('dept_approved', undefined, SOURCING)).toBe(true);
    expect(canStartRfq('dept_approved', 'rfq-1', SOURCING)).toBe(false);
    expect(canStartRfq('sourcing', null, SOURCING)).toBe(false);
    expect(canStartRfq('draft', null, SOURCING)).toBe(false);
    expect(canStartRfq('dept_approved', null, NONE)).toBe(false);
  });
});

describe('submissionConvertibility', () => {
  it('only a clean scan can be converted', () => {
    expect(submissionConvertibility('clean').convertible).toBe(true);
  });
  it('says why every other scan state cannot, including no version yet', () => {
    for (const s of ['quarantined', 'awaiting_content', 'infected', 'rejected', 'failed', null]) {
      const c = submissionConvertibility(s);
      expect(c.convertible).toBe(false);
      expect(c.reason).not.toBe('');
      expect(c.label).not.toBe('');
    }
  });
});

describe('decisions', () => {
  it('scores and recommendations are taken while the RFQ is open or closed', () => {
    expect(takesDecisions('open')).toBe(true);
    expect(takesDecisions('closed')).toBe(true);
    expect(takesDecisions('recommended')).toBe(false);
    expect(takesDecisions('cancelled')).toBe(false);
  });
});

describe('canCommit', () => {
  const ok = { status: 'recommended' as const, recommendedQuotationId: 'q', prStatus: 'sourcing' };
  it('needs a recommendation, a sourcing request and the sourcing grant', () => {
    expect(canCommit(ok, SOURCING)).toEqual({ show: true });
    expect(canCommit({ ...ok, status: 'open' }, SOURCING)).toEqual({ show: false });
    expect(canCommit({ ...ok, recommendedQuotationId: null }, SOURCING)).toEqual({
      show: false,
    });
    expect(canCommit(ok, NONE)).toEqual({ show: false });
  });
  it('a request already waiting on the approvers is not offered again', () => {
    expect(canCommit({ ...ok, prStatus: 'commitment_pending' }, SOURCING)).toEqual({
      show: false,
    });
  });
  it('when the request did not load, hides the button and says why', () => {
    const r = canCommit({ ...ok, prStatus: null }, SOURCING);
    expect(r.show).toBe(false);
    expect(r.why).toMatch(/purchase request/i);
  });
});

describe('the quotation deadline (F1-Q47)', () => {
  const deadline = '2026-11-20T04:15:00.000Z';
  it('has passed only strictly after the deadline instant', () => {
    expect(deadlinePassed(deadline, new Date('2026-11-20T04:15:00.000Z'))).toBe(false);
    expect(deadlinePassed(deadline, new Date('2026-11-20T04:15:00.001Z'))).toBe(true);
    expect(deadlinePassed('2026-11-20T10:00:00+05:45', new Date('2026-11-20T04:14:59Z'))).toBe(
      false,
    );
  });
  it('marks an upload sent after the deadline as late, whatever its scan says', () => {
    expect(arrivedLate('2026-11-20T04:15:00.000Z', deadline)).toBe(false);
    expect(arrivedLate('2026-11-20T04:16:00.000Z', deadline)).toBe(true);
    const late = submissionConvertibility('clean', true);
    expect(late.convertible).toBe(false);
    expect(late.label).toBe('Arrived late');
    expect(late.reason).toMatch(/after the quotation deadline/);
    expect(submissionConvertibility('clean', false).convertible).toBe(true);
  });
  it('is extended only on an open RFQ, by someone who may source', () => {
    expect(canExtendDeadline('open', SOURCING)).toBe(true);
    expect(canExtendDeadline('open', NONE)).toBe(false);
    for (const status of ['closed', 'recommended', 'cancelled'] as const) {
      expect(canExtendDeadline(status, SOURCING)).toBe(false);
    }
  });
});
