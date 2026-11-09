import { RFQ_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  canCommit,
  canStartRfq,
  RFQ_STATUS_LABEL,
  RFQ_STATUS_NOTE,
  rfqGrants,
  submissionConvertibility,
  takesDecisions,
} from './model';

describe('labels', () => {
  it('every RFQ status has a label and a note', () => {
    for (const s of RFQ_STATUSES) {
      expect(RFQ_STATUS_LABEL[s].text).not.toBe('');
      expect(RFQ_STATUS_NOTE[s]).not.toBe('');
    }
  });
});

describe('rfqGrants', () => {
  it('procurement may source; a plain requester may not', () => {
    expect(rfqGrants(['procurement']).sourcing).toBe(true);
    expect(rfqGrants(['sales']).sourcing).toBe(false);
    expect(rfqGrants([]).sourcing).toBe(false);
  });
});

describe('canStartRfq', () => {
  it('needs a department-approved request with no RFQ and the sourcing grant', () => {
    expect(canStartRfq('dept_approved', null, ['procurement'])).toBe(true);
    expect(canStartRfq('dept_approved', undefined, ['procurement'])).toBe(true);
    expect(canStartRfq('dept_approved', 'rfq-1', ['procurement'])).toBe(false);
    expect(canStartRfq('sourcing', null, ['procurement'])).toBe(false);
    expect(canStartRfq('draft', null, ['procurement'])).toBe(false);
    expect(canStartRfq('dept_approved', null, ['sales'])).toBe(false);
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
    expect(canCommit(ok, ['procurement'])).toEqual({ show: true });
    expect(canCommit({ ...ok, status: 'open' }, ['procurement'])).toEqual({ show: false });
    expect(canCommit({ ...ok, recommendedQuotationId: null }, ['procurement'])).toEqual({
      show: false,
    });
    expect(canCommit(ok, ['viewer'])).toEqual({ show: false });
  });
  it('a request already waiting on the approvers is not offered again', () => {
    expect(canCommit({ ...ok, prStatus: 'commitment_pending' }, ['procurement'])).toEqual({
      show: false,
    });
  });
  it('when the request did not load, hides the button and says why', () => {
    const r = canCommit({ ...ok, prStatus: null }, ['procurement']);
    expect(r.show).toBe(false);
    expect(r.why).toMatch(/purchase request/i);
  });
});
