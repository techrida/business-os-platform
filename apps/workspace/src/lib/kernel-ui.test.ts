import { describe, expect, it } from 'vitest';

import { canSeeAdmin, money, snapshotEntries, when } from './kernel-format';
import {
  describeFailure,
  formatBytes,
  guessMime,
  humanizeKey,
  needsPolling,
  safeLocalPath,
  scanLabel,
  shortId,
} from './kernel-ui';

describe('describeFailure', () => {
  it.each([
    ['separation_of_duties', "You prepared this document, so you can't approve it."],
    ['no_permission', "Your roles don't allow this action. Ask an administrator if you need it."],
  ])('words the 403 reason %s', (reason, message) => {
    expect(describeFailure({ status: 403, reason }).message).toBe(message);
  });

  it('falls back for an unknown 403 reason', () => {
    expect(describeFailure({ status: 403, reason: 'new_reason' }).message).toBe(
      "You don't have permission to do this.",
    );
  });

  it('marks 4xx as definite and 5xx, 429 and network errors as not', () => {
    expect(describeFailure({ status: 400 }).definite).toBe(true);
    expect(describeFailure({ status: 500 }).definite).toBe(false);
    expect(describeFailure({ status: 429 }).definite).toBe(false);
    expect(describeFailure({ status: 0 }).definite).toBe(false);
  });

  it('shows the API detail only on 400', () => {
    expect(describeFailure({ status: 400, detail: 'amount: bad' }).message).toContain(
      'amount: bad',
    );
    expect(describeFailure({ status: 500, detail: 'secret' }).message).not.toContain('secret');
  });

  it('asks for reload on a 409 during attachment removal', () => {
    const f = describeFailure({ status: 409 }, 'remove');
    expect(f.reload).toBe(true);
    expect(f.definite).toBe(true);
    expect(f.message).toContain('draft or returned');
  });
});

describe('safeLocalPath', () => {
  it.each(['/inbox/abc', '/memos/new?x=1'])('keeps %s', (p) => {
    expect(safeLocalPath(p)).toBe(p);
  });
  it.each(['//evil.test', 'https://evil.test', 'javascript:alert(1)', '/\\evil', '/a\nb', ''])(
    'drops %j',
    (p) => {
      expect(safeLocalPath(p)).toBeNull();
    },
  );
});

describe('small formatters', () => {
  it('humanizes keys', () => {
    expect(humanizeKey('amountNpr')).toBe('Amount NPR');
    expect(humanizeKey('fx_rate')).toBe('FX rate');
    expect(humanizeKey('title')).toBe('Title');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(26_214_400)).toBe('25.0 MB');
  });
  it('guesses a mime, preferring a known extension', () => {
    expect(guessMime('a.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(guessMime('a.unknown', '')).toBe('application/octet-stream');
    expect(guessMime('a.bin', 'application/x-foo')).toBe('application/x-foo');
  });
  it('shortens ids and labels scans', () => {
    expect(shortId('11111111-1111-4111-8111-abcdefghijkl')).toBe('efghijkl'.padStart(8));
    expect(scanLabel('clean').tone).toBe('good');
    expect(scanLabel('quarantined').tone).toBe('wait');
    expect(scanLabel('infected').tone).toBe('bad');
  });
  it('polls only while something is scanning', () => {
    expect(needsPolling(['clean', 'quarantined'])).toBe(true);
    expect(needsPolling(['clean', 'infected'])).toBe(false);
    expect(needsPolling([])).toBe(false);
  });
});

describe('display helpers', () => {
  it('formats money in lakh grouping and leaves odd text alone', () => {
    expect(money('1250000.5')).toBe('NPR 12,50,000.50');
    expect(money('abc')).toBe('abc');
  });
  it('formats a time in Kathmandu', () => {
    expect(when('2025-07-16T23:59:00.000Z')).toBe('17 Jul 2025, 05:44');
    expect(when('not a date')).toBe('not a date');
  });
  it('labels snapshot rows and formats money and dates', () => {
    const rows = snapshotEntries({
      title: 'Laptop',
      amount: '1000.00',
      currency: 'USD',
      amountNpr: '133000.00',
      submittedAt: '2025-07-16T23:59:00.000Z',
      editors: ['a'],
      note: null,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by['amount']?.value).toBe('USD 1,000.00');
    expect(by['amountNpr']?.label).toBe('Amount NPR');
    expect(by['amountNpr']?.value).toBe('NPR 1,33,000.00');
    expect(by['submittedAt']?.value).toBe('17 Jul 2025, 05:44');
    expect(by['editors']?.block).toBe(true);
    // A null field has no value, so it has no row (it used to render as "None").
    expect(by['note']).toBeUndefined();
  });
  it('handles an empty or non-object snapshot', () => {
    expect(snapshotEntries(null)).toEqual([]);
    expect(snapshotEntries([])).toEqual([]);
    expect(snapshotEntries('')).toEqual([]);
    expect(snapshotEntries('text')[0]?.block).toBe(true);
  });
  // The snapshot of a memo submitted without a template or files, in the shape test-memo.service.ts submit()
  // freezes it (the API package cannot be imported here, so the shape is spelled out: keep the two in step).
  const frozenMemo = {
    template: null,
    number: 'MEMO-2026-0007',
    title: 'Laptop for the new hire',
    body: 'Please approve.',
    amount: '1000.00',
    currency: 'USD',
    amountNpr: '133000.00',
    fxRate: '133.00',
    fxSource: 'nrb',
    fxDate: '2026-11-17',
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    customerPartyId: null,
    memoVersion: 2,
    attachments: [],
  };
  it('gives empty fields of a real memo snapshot no row, so no [] or None reaches the screen', () => {
    const rows = snapshotEntries(frozenMemo);
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain('attachments');
    expect(keys).not.toContain('template');
    expect(keys).not.toContain('customerPartyId');
    expect(rows.map((r) => r.value)).not.toContain('[]');
    expect(rows.map((r) => r.value)).not.toContain('None');
    expect(rows.find((r) => r.key === 'amount')?.value).toBe('USD 1,000.00');
    expect(rows.find((r) => r.key === 'memoVersion')?.value).toBe('2');
  });
  it('keeps the attachments of a memo that has files, and zero and false values', () => {
    const rows = snapshotEntries({
      ...frozenMemo,
      attachments: [{ documentId: 'd1', filename: 'quote.pdf', sha256: null }],
      memoVersion: 0,
      flag: false,
    });
    const attachments = rows.find((r) => r.key === 'attachments');
    expect(attachments?.block).toBe(true);
    expect(attachments?.value).toContain('quote.pdf');
    expect(rows.find((r) => r.key === 'memoVersion')?.value).toBe('0');
    expect(rows.find((r) => r.key === 'flag')?.value).toBe('false');
  });
  it('shows Admin only for roles whose default grants include admin.*', () => {
    expect(canSeeAdmin(['founder'])).toBe(true);
    expect(canSeeAdmin(['sales', 'finance'])).toBe(false);
    expect(canSeeAdmin([])).toBe(false);
    expect(canSeeAdmin(['nonsense'])).toBe(false);
  });
});

describe('upload header helpers', () => {
  it('decodes the file name header and rejects malformed escapes', async () => {
    const { decodeFileName, baseMime, toAttachmentView } = await import('./kernel-ui');
    expect(decodeFileName('quote%20v2.pdf')).toBe('quote v2.pdf');
    expect(decodeFileName('%E0%A4')).toBeNull();
    expect(decodeFileName(null)).toBeNull();
    expect(baseMime('Text/CSV; charset=utf-8')).toBe('text/csv');
    expect(baseMime(null)).toBe('');
    expect(
      toAttachmentView({ id: 'a', documentId: 'b', filename: 'c', sizeBytes: 1, status: 'clean' }),
    ).toEqual({ id: 'a', documentId: 'b', filename: 'c', sizeBytes: 1, status: 'clean' });
  });
});
