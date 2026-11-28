import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InboxPage from './page';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getInboxSummary: vi.fn(),
  getInboxPage: vi.fn(),
  getNumberSystems: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: mocks.getNumberSystems }));
vi.mock('@/lib/api-kernel', async (original) => ({
  ...(await original<typeof import('@/lib/api-kernel')>()),
  getInboxSummary: mocks.getInboxSummary,
  getInboxPage: mocks.getInboxPage,
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['approver'] });
  mocks.getNumberSystems.mockResolvedValue('western');
});

describe('inbox page reads', () => {
  it('starts display settings and the aggregate summary with the list read, not after it', async () => {
    let finishList: (page: { items: object[]; total: number }) => void = () => undefined;
    mocks.getInboxPage.mockReturnValue(new Promise((resolve) => (finishList = resolve)));
    mocks.getInboxSummary.mockReturnValue(new Promise(() => {}));

    const pending = InboxPage({ searchParams: Promise.resolve({}) });
    await tick();
    // The list read has not answered; the other two reads are already out.
    expect(mocks.getInboxPage).toHaveBeenCalledTimes(1);
    expect(mocks.getInboxSummary).toHaveBeenCalledTimes(1);
    expect(mocks.getNumberSystems).toHaveBeenCalledTimes(1);

    finishList({
      items: [
        {
          requestId: 'item-1',
          title: 'Travel request',
          reason: 'Finance review',
          documentNumber: 'TR-1',
          amountNpr: null,
          submittedAt: '2026-11-08T04:00:00Z',
        },
      ],
      total: 1,
    });
    expect(renderToStaticMarkup(await pending)).toContain('Travel request');
  });
});
