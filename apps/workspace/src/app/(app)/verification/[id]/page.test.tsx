import type { VerificationCaseDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import VerificationCasePage from './page';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  getVerificationCase: vi.fn(),
  getReviewHistory: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: ['founder'] }),
}));
vi.mock('@/components/p2/customers/api', () => ({
  getCustomer: () => Promise.resolve(undefined),
  getVerificationCase: mocks.getVerificationCase,
}));
vi.mock('@/components/p2/crm/verification-api', () => ({
  getVerificationReviewHistory: mocks.getReviewHistory,
  getDocument: mocks.getDocument,
}));

const id = '00000000-0000-4000-8000-000000000001';

async function render(partyKind: 'vendor' | 'customer') {
  mocks.getVerificationCase.mockResolvedValue({
    id,
    partyKind,
    partyId: id,
    status: 'approved',
    checklist: [],
    reviewedBy: null,
    decidedAt: null,
    decisionNote: null,
    version: 1,
  } satisfies VerificationCaseDto);
  return renderToStaticMarkup(
    await VerificationCasePage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    }),
  );
}

beforeEach(() => {
  mocks.getReviewHistory.mockReset().mockResolvedValue({ items: [] });
});

it('shows the vendor decision without the customer review history', async () => {
  const html = await render('vendor');
  expect(html).toContain('This vendor is verified.');
  expect(html).not.toContain('Review history');
  expect(mocks.getReviewHistory).not.toHaveBeenCalled();
});

it('shows the history for a customer case and reports a customer history failure', async () => {
  expect(await render('customer')).toContain('No decisions recorded.');
  mocks.getReviewHistory.mockRejectedValueOnce(new Error('Unavailable'));
  expect(await render('customer')).toContain('Review history could not be loaded.');
});

// The review controls follow the case's own `can` flags, not the session's role names: the session here is a
// founder, so a page still gating on role defaults would offer review on both cases.
async function renderSubmitted(can: VerificationCaseDto['can'], reviewBlockedReason?: string) {
  mocks.getVerificationCase.mockResolvedValue({
    ...(reviewBlockedReason === undefined ? {} : { reviewBlockedReason }),
    id,
    partyKind: 'customer',
    partyId: id,
    status: 'submitted',
    checklist: [],
    reviewedBy: null,
    decidedAt: null,
    decisionNote: null,
    version: 1,
    can,
  } satisfies VerificationCaseDto);
  return renderToStaticMarkup(
    await VerificationCasePage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    }),
  );
}

it('offers review only when the case says this person may review it', async () => {
  const none = { review: false, edit: false, attach: false, remove: false };
  const locked = await renderSubmitted(none);
  expect(locked).toContain('The documents are locked while this case is under review.');
  expect(locked).not.toContain('Review the documents before recording a decision.');

  expect(await renderSubmitted(undefined)).toContain(
    'The documents are locked while this case is under review.',
  );

  expect(await renderSubmitted({ ...none, review: true })).toContain(
    'Review the documents before recording a decision.',
  );
});

it('tells the submitter why they cannot review their own case', async () => {
  const none = { review: false, edit: false, attach: false, remove: false };
  const out = await renderSubmitted(
    none,
    'You submitted this case, so someone else must review it.',
  );
  expect(out).toContain('You submitted this case, so someone else must review it.');
  expect(out).not.toContain('The documents are locked while this case is under review.');
});

// The expiry rule is a calendar day in Kathmandu (UTC+05:45), not in UTC: a file must expire strictly after
// today. At 2026-11-19T20:30Z it is already 02:15 on the 20th in Kathmandu, so a file expiring on the 20th has
// run out, even though UTC still reads the 19th.
async function renderProvided(expiresOn: string) {
  const documentId = '00000000-0000-4000-8000-000000000002';
  const versionId = '00000000-0000-4000-8000-000000000003';
  mocks.getDocument.mockResolvedValue({
    id: documentId,
    ownerType: 'verification_case',
    ownerId: id,
    currentVersionId: versionId,
    versions: [
      {
        id: versionId,
        documentId,
        version: 1,
        filename: 'registration.pdf',
        declaredMime: 'application/pdf',
        detectedMime: 'application/pdf',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        status: 'clean',
        scanSignature: null,
        scannedAt: '2026-11-18T10:00:00.000Z',
        uploadedBy: id,
        createdAt: '2026-11-18T09:00:00.000Z',
      },
    ],
  });
  mocks.getVerificationCase.mockResolvedValue({
    id,
    partyKind: 'customer',
    partyId: id,
    status: 'submitted',
    reviewPolicy: 'document_review_v1',
    checklist: [
      {
        key: 'registration_certificate',
        required: true,
        status: 'provided',
        documentId,
        expiresOn,
        evidence: { documentId, documentVersionId: versionId, versionNumber: 1, expiresOn },
      },
    ],
    reviewedBy: null,
    decidedAt: null,
    decisionNote: null,
    version: 1,
    can: { review: true, edit: false, attach: false, remove: false },
  } satisfies VerificationCaseDto);
  return renderToStaticMarkup(
    await VerificationCasePage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

it('does not offer approval of a file that expires today in Kathmandu while UTC is still on the day before', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T20:30:00Z'));

  const expired = await renderProvided('2026-11-20');
  expect(expired).toMatch(/aria-label="Approve [^"]*" aria-disabled="true"/);
  // UIP-FORM-011: that reason is the Approve button's tooltip, not text under it.
  expect(expired).not.toContain('Approval requires a clean, unexpired file.');

  const current = await renderProvided('2026-11-21');
  expect(current).toMatch(/aria-label="Approve [^"]*" aria-disabled="false"/);
  expect(current).not.toContain('Approval requires a clean, unexpired file.');
});

// R6AE: a case reset by a change of the party's identity says so, and keeps the earlier files as history.
async function renderReset(partyKind: 'vendor' | 'customer') {
  const oldDocumentId = '00000000-0000-4000-8000-0000000000aa';
  mocks.getVerificationCase.mockResolvedValue({
    id,
    partyKind,
    partyId: id,
    status: 'draft',
    checklist: [],
    reviewedBy: null,
    decidedAt: null,
    decisionNote: null,
    version: 3,
    identityReset: { at: '2026-11-23T04:00:00.000Z', by: id, byName: 'Sita Founder' },
    beforeChangeDocumentIds: [oldDocumentId],
    looseEvidence: [
      {
        id: '00000000-0000-4000-8000-0000000000ab',
        documentId: oldDocumentId,
        version: 1,
        filename: 'old-registration.pdf',
        declaredMime: 'application/pdf',
        detectedMime: 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        status: 'clean',
        scanSignature: null,
        scannedAt: '2026-11-20T04:00:00.000Z',
        uploadedBy: null,
        createdAt: '2026-11-20T04:00:00.000Z',
      },
    ],
    can: { review: false, edit: true, attach: true, remove: true },
  } satisfies VerificationCaseDto);
  return renderToStaticMarkup(
    await VerificationCasePage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    }),
  );
}

it.each(['vendor', 'customer'] as const)(
  'shows who changed the %s details, and marks the earlier files "Before the change"',
  async (kind) => {
    const html = await renderReset(kind);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/Details changed on .* by Sita Founder ; upload the documents again\./);
    expect(text).toContain('old-registration.pdf');
    expect(text).toContain('Before the change');
    // A vendor case has no loose-file removal; a customer's keeps it.
    expect(html.includes('Remove old-registration.pdf')).toBe(kind === 'customer');
  },
);

it('shows no reset note for a case that was never reset', async () => {
  expect(await render('customer')).not.toContain('Details changed');
});
