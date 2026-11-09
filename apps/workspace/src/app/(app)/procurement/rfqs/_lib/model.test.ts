import { RFQ_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  canStartRfq,
  RFQ_STATUS_LABEL,
  RFQ_STATUS_NOTE,
  rfqGrants,
  submissionConvertibility,
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
      const c = submissionConvertibility(s as never);
      expect(c.convertible).toBe(false);
      expect(c.reason).not.toBe('');
      expect(c.label).not.toBe('');
    }
  });
});
