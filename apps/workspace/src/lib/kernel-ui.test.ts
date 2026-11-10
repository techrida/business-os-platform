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

  it.each([
    ['duplicate_pan_vat', 'Another customer already has this PAN/VAT number.'],
    ['primary_contact_exists', 'This customer already has a primary contact.'],
    ['kyb_not_verified', "This customer's verification must be approved first."],
  ])('words the 409 code %s, and does not ask for a reload', (code, message) => {
    const f = describeFailure({ status: 409, code });
    expect(f.message).toBe(message);
    expect(f.reload).toBe(false);
    expect(f.definite).toBe(true);
  });

  it('words a coded 409 the same in every context', () => {
    expect(describeFailure({ status: 409, code: 'duplicate_pan_vat' }, 'submit').message).toBe(
      'Another customer already has this PAN/VAT number.',
    );
  });

  it('keeps the reload wording for a plain or unknown-coded 409', () => {
    for (const code of [undefined, 'conflict', 'something_new']) {
      const f = describeFailure({ status: 409, code });
      expect(f.message).toBe('This item changed since you opened it. Reload and try again.');
      expect(f.reload).toBe(true);
    }
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
    expect(by['note']?.value).toBe('None');
  });
  it('keeps business numbers and audit facts while replacing nested technical references', () => {
    const snapshot = {
      number: 'MEM-001',
      taxId: 'PAN-12345',
      ownerUserId: 'opaque-owner',
      amountNpr: '100.00',
      attachments: [
        {
          documentId: 'opaque-document',
          versionId: 'opaque-version',
          filename: 'receipt.pdf',
          sha256: 'audit-hash',
        },
      ],
    };
    const rows = snapshotEntries(snapshot);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('opaque-');
    expect(text).toContain('MEM-001');
    expect(text).toContain('PAN-12345');
    expect(text).toContain('receipt.pdf');
    expect(text).toContain('audit-hash');
    expect(text).toContain('Name unavailable');
    expect(snapshot.ownerUserId).toBe('opaque-owner');
    expect(
      snapshotEntries(snapshot, new Map([['opaque-owner', 'Mina']])).find(
        (row) => row.key === 'ownerUser',
      )?.value,
    ).toBe('Mina');
  });
  it('resolves or redacts unknown P4 UUID references and nested arrays while keeping business facts', () => {
    const billId = '11111111-1111-4111-8111-111111111111';
    const supplierPartyId = '22222222-2222-4222-8222-222222222222';
    const purchaseOrderId = '33333333-3333-4333-8333-333333333333';
    const snapshot = {
      billId,
      supplierPartyId,
      purchaseOrderId,
      lines: [{ references: [billId, supplierPartyId] }],
      taxId: 'PAN-12345',
      sha256: 'audit-hash',
    };
    const rows = snapshotEntries(snapshot, new Map([[billId, 'Supplier bill 1']]));
    const text = JSON.stringify(rows);
    for (const id of [billId, supplierPartyId, purchaseOrderId]) expect(text).not.toContain(id);
    expect(text).toContain('Supplier bill 1');
    expect(text).toContain('Name unavailable');
    expect(text).toContain('PAN-12345');
    expect(text).toContain('audit-hash');
    expect(snapshot.lines[0]?.references).toEqual([billId, supplierPartyId]);
  });
  it('handles an empty or non-object snapshot', () => {
    expect(snapshotEntries(null)).toEqual([]);
    expect(snapshotEntries('text')[0]?.block).toBe(true);
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
