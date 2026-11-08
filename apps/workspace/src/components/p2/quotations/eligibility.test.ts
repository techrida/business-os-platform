import { EVIDENCE_KINDS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  canRecordOutcome,
  eligibleContacts,
  EVIDENCE_LABELS,
  EVIDENCE_ORDER,
  isExpired,
  kathmanduToday,
  preselectedContactId,
  sendGate,
  type SendGateInput,
} from './eligibility';

const TODAY = '2026-11-08';
const ok = (over: Partial<SendGateInput> = {}): SendGateInput => ({
  status: 'approved',
  renderedScanStatus: 'clean',
  validUntil: '2026-11-23',
  ...over,
});
const mail = [{ email: 'a@example.com' }];

describe('kathmanduToday', () => {
  it('is the Kathmandu calendar day, UTC+05:45, not the UTC day', () => {
    expect(kathmanduToday(new Date('2026-11-08T18:14:00Z'))).toBe('2026-11-08');
    expect(kathmanduToday(new Date('2026-11-08T18:15:00Z'))).toBe('2026-11-09');
    expect(kathmanduToday(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });
});

describe('isExpired', () => {
  it('counts the last valid day as still valid and the day after as expired', () => {
    expect(isExpired({ status: 'approved', validUntil: TODAY }, TODAY)).toBe(false);
    expect(isExpired({ status: 'approved', validUntil: '2026-11-07' }, TODAY)).toBe(true);
  });
  it('is expired whenever the status says so, whatever the date', () => {
    expect(isExpired({ status: 'expired', validUntil: '2030-01-01' }, TODAY)).toBe(true);
  });
});

describe('sendGate', () => {
  it('is open only for an approved, clean, unexpired quotation with an eligible contact', () => {
    expect(sendGate(ok(), mail, TODAY)).toEqual({ ok: true });
    expect(sendGate(ok({ validUntil: TODAY }), mail, TODAY)).toEqual({ ok: true });
  });

  it('blocks every status but approved, in words', () => {
    for (const status of [
      'draft',
      'submitted',
      'returned',
      'sent',
      'accepted',
      'rejected',
    ] as const) {
      const got = sendGate(ok({ status }), mail, TODAY);
      expect(got).toEqual({ ok: false, reason: 'Only an approved quotation can be sent.' });
    }
  });

  it('blocks an expired status and a validity date before today', () => {
    for (const input of [ok({ status: 'expired' }), ok({ validUntil: '2026-11-07' })]) {
      const got = sendGate(input, mail, TODAY);
      expect(got.ok).toBe(false);
      expect(!got.ok && got.reason).toMatch(/expired/);
    }
  });

  it('blocks a file that is not clean: null, awaiting, quarantined, infected, rejected, failed', () => {
    const reasons = new Set<string>();
    for (const scan of [
      null,
      'awaiting_content',
      'quarantined',
      'infected',
      'rejected',
      'scan_failed',
    ] as const) {
      const got = sendGate(ok({ renderedScanStatus: scan }), mail, TODAY);
      expect(got.ok).toBe(false);
      if (!got.ok) reasons.add(got.reason);
    }
    expect(reasons.size).toBe(3);
    expect([...reasons].join(' ')).not.toMatch(/infected|virus|malware/i);
  });

  it('blocks when no contact has an email address', () => {
    for (const contacts of [[], [{ email: null }], [{ email: '  ' }]]) {
      const got = sendGate(ok(), contacts, TODAY);
      expect(got.ok).toBe(false);
      expect(!got.ok && got.reason).toMatch(/email address/);
    }
  });
});

describe('contacts', () => {
  const a = { id: 'a', email: 'a@example.com' };
  const b = { id: 'b', email: null };
  it('keeps only contacts with an email', () => {
    expect(eligibleContacts([a, b])).toEqual([a]);
  });
  it('preselects the version contact only when it can receive email', () => {
    expect(preselectedContactId('a', [a, b])).toBe('a');
    expect(preselectedContactId('b', [a, b])).toBe('');
    expect(preselectedContactId('gone', [a, b])).toBe('');
    expect(preselectedContactId(null, [a, b])).toBe('');
  });
});

describe('outcome and evidence', () => {
  it('records an outcome only on a sent version', () => {
    expect(canRecordOutcome('sent')).toBe(true);
    for (const s of ['draft', 'approved', 'accepted', 'rejected', 'superseded'] as const)
      expect(canRecordOutcome(s)).toBe(false);
  });
  it('labels every evidence kind once', () => {
    expect(Object.keys(EVIDENCE_LABELS).sort()).toEqual([...EVIDENCE_KINDS].sort());
    expect([...EVIDENCE_ORDER].sort()).toEqual([...EVIDENCE_KINDS].sort());
  });
});
