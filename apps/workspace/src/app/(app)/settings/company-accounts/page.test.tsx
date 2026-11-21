import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/company-accounts',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const session = { accessToken: 't', orgKind: 'staff', roles: ['accountant'] } as Session;
vi.mock('../guard', () => ({ requireSection: vi.fn(() => Promise.resolve(session)) }));
vi.mock('@/lib/enabled-currencies.server', () => ({
  loadEnabledCurrencies: vi.fn(() => Promise.resolve(['NPR', 'USD'])),
}));
const api = vi.hoisted(() => ({
  listCompanyBankAccounts: vi.fn(),
  listExpenseAccounts: vi.fn(),
}));
vi.mock('@/lib/api-company-accounts', () => ({
  ...api,
  createCompanyBankAccount: vi.fn(),
  renameCompanyBankAccount: vi.fn(),
  retireCompanyBankAccount: vi.fn(),
  reactivateCompanyBankAccount: vi.fn(),
  createExpenseAccount: vi.fn(),
  renameExpenseAccount: vi.fn(),
  retireExpenseAccount: vi.fn(),
  reactivateExpenseAccount: vi.fn(),
}));

const { default: CompanyAccountsPage, metadata } = await import('./page');

const render = async () => renderToStaticMarkup((await CompanyAccountsPage()) as ReactElement);
const visible = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const bank = (over: Partial<Record<string, unknown>> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Operating account',
  bankName: 'Nabil Bank',
  last4: '4821',
  currency: 'NPR',
  status: 'active',
  retiredAt: null,
  ...over,
});
const expense = (over: Partial<Record<string, unknown>> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  code: '5100',
  name: 'Office supplies',
  status: 'active',
  retiredAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listCompanyBankAccounts.mockResolvedValue([]);
  api.listExpenseAccounts.mockResolvedValue([]);
});

describe('the bank and expense accounts page', () => {
  it('is titled for the browser tab and loads both lists with retired rows included', async () => {
    expect(metadata.title).toBe('Bank and expense accounts · Business OS');
    await render();
    expect(api.listCompanyBankAccounts).toHaveBeenCalledWith(session, { includeRetired: true });
    expect(api.listExpenseAccounts).toHaveBeenCalledWith(session, { includeRetired: true });
  });

  it('names the first thing to add when both lists are empty, with both add forms ready', async () => {
    const text = visible(await render());
    expect(text).toContain('No bank accounts yet');
    expect(text).toContain('Add the account your payments leave from');
    expect(text).toContain('No expense accounts yet');
    expect(text).toContain('Add the first expense account above');
    expect(text).toContain('Last four characters of the account number');
    expect(text).toContain('Add bank account');
    expect(text).toContain('Add expense account');
    expect(text).not.toMatch(/delete/i);
  });

  it('lists accounts with the masked ending, currency and status, plus rename and retire', async () => {
    api.listCompanyBankAccounts.mockResolvedValue([bank()]);
    api.listExpenseAccounts.mockResolvedValue([expense()]);
    const html = await render();
    const text = visible(html);

    expect(text).toContain('Operating account');
    expect(text).toContain('Nabil Bank');
    expect(text).toContain('····4821');
    expect(text).toContain('NPR');
    expect(text).toContain('Active');
    expect(text).toContain('5100');
    expect(text).toContain('Office supplies');
    expect(html).toContain('aria-label="Rename Operating account"');
    expect(html).toContain('aria-label="Rename 5100 Office supplies"');
    expect(html).toContain('aria-label="Retire Operating account (Nabil Bank ····4821)"');
    expect(html).toContain('aria-label="Retire 5100 Office supplies"');
    expect(text).not.toContain('No bank accounts yet');
    expect(text).not.toMatch(/delete/i);
  });

  it('puts retired rows under a Retired heading with Reactivate instead of Retire', async () => {
    api.listCompanyBankAccounts.mockResolvedValue([
      bank(),
      bank({
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Old savings',
        last4: '0007',
        status: 'retired',
        retiredAt: '2026-10-01T00:00:00Z',
      }),
    ]);
    api.listExpenseAccounts.mockResolvedValue([
      expense({ status: 'retired', retiredAt: '2026-10-01T00:00:00Z' }),
    ]);
    const html = await render();
    const text = visible(html);

    expect(html.match(/<h3[^>]*>Retired<\/h3>/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Reactivate Old savings (Nabil Bank ····0007)"');
    expect(html).not.toContain('aria-label="Rename Old savings"');
    expect(html).not.toContain('aria-label="Retire Old savings');
    expect(html).toContain('aria-label="Reactivate 5100 Office supplies"');
    // Only retired expense accounts: the active list says none are in use, not "yet".
    expect(text).toContain('No expense accounts in use');
    expect(text).not.toContain('No expense accounts yet');
  });

  it('shows a section error instead of a blank panel when a list fails to load', async () => {
    api.listCompanyBankAccounts.mockRejectedValue(new ApiError(403, 'forbidden'));
    api.listExpenseAccounts.mockResolvedValue([expense()]);
    const text = visible(await render());

    expect(text).toContain("You don't have permission to view bank accounts.");
    expect(text).not.toContain('Add bank account');
    // The other list still renders.
    expect(text).toContain('Office supplies');
    expect(text).toContain('Add expense account');
  });
});
