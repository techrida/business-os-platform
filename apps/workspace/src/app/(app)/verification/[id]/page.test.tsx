import type { VerificationCaseDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import VerificationCasePage from './page';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getVerificationCase: vi.fn(),
  getReviewHistory: vi.fn(),
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
async function renderSubmitted(can: VerificationCaseDto['can']) {
  mocks.getVerificationCase.mockResolvedValue({
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
