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
