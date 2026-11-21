// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';
import { click, fill, mountForm, submit } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const session = { accessToken: 't', orgKind: 'staff', roles: ['accountant'] } as Session;
vi.mock('../guard', () => ({ requireSection: vi.fn(() => Promise.resolve(session)) }));
const mocks = vi.hoisted(() => ({
  createCompanyBankAccount: vi.fn(),
  renameCompanyBankAccount: vi.fn(),
  retireCompanyBankAccount: vi.fn(),
  reactivateCompanyBankAccount: vi.fn(),
  createExpenseAccount: vi.fn(),
  renameExpenseAccount: vi.fn(),
  retireExpenseAccount: vi.fn(),
  reactivateExpenseAccount: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/api-company-accounts', () => mocks);
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { AddExpenseAccountForm, ReactivateButton, RenameableName, RetireButton } =
  await import('./account-forms');

const BANK = '11111111-1111-4111-8111-111111111111';
const EXPENSE = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
}

const button = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  ) ?? null;
const dialogButton = (label: string) => {
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  return dialog ? button(label, dialog) : null;
};

describe('retire', () => {
  it('asks first, says documents keep working, and Cancel changes nothing', async () => {
    const view = await mountForm(<RetireButton kind="bank" id={BANK} label="Operating account" />);
    await click(button('Retire Operating account'));

    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    expect(dialog?.textContent).toContain('Retire Operating account?');
    expect(dialog?.textContent).toContain('new payment requests');
    expect(dialog?.textContent).toContain('Documents already using it keep showing its name');

    await click(dialogButton('Cancel'));
    await settle();
    expect(mocks.retireCompanyBankAccount).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await view.unmount();
  });

  it('retires on confirm and closes', async () => {
    mocks.retireExpenseAccount.mockResolvedValue({ id: EXPENSE, code: '5100', name: 'Office' });
    const view = await mountForm(<RetireButton kind="expense" id={EXPENSE} label="5100 Office" />);
    await click(button('Retire 5100 Office'));
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain(
      'new bills',
    );

    await click(dialogButton('Retire expense account'));
    await settle();
    expect(mocks.retireExpenseAccount).toHaveBeenCalledWith(session, EXPENSE, expect.any(String));
    expect(mocks.success).toHaveBeenCalledWith('Retired 5100 Office.');
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await view.unmount();
  });

  it('stays open and reports a refused retire', async () => {
    mocks.retireCompanyBankAccount.mockRejectedValue(new ApiError(403, 'forbidden'));
    const view = await mountForm(<RetireButton kind="bank" id={BANK} label="Operating account" />);
    await click(button('Retire Operating account'));
    await click(dialogButton('Retire bank account'));
    await settle();

    expect(mocks.error).toHaveBeenCalledWith("You don't have permission to retire bank accounts.");
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('reactivate', () => {
  it('reactivates in one click', async () => {
    mocks.reactivateCompanyBankAccount.mockResolvedValue({ id: BANK, name: 'Old savings' });
    const view = await mountForm(<ReactivateButton kind="bank" id={BANK} label="Old savings" />);
    await click(button('Reactivate Old savings'));
    await settle();

    expect(mocks.reactivateCompanyBankAccount).toHaveBeenCalledWith(
      session,
      BANK,
      expect.any(String),
    );
    expect(mocks.success).toHaveBeenCalledWith('Reactivated Old savings.');
    await view.unmount();
  });
});

describe('rename', () => {
  it('opens an inline form, saves the new name and closes; Cancel restores the name', async () => {
    mocks.renameCompanyBankAccount.mockResolvedValue({ id: BANK, name: 'Payroll' });
    const view = await mountForm(<RenameableName kind="bank" id={BANK} name="Operating account" />);

    await click(button('Rename Operating account'));
    const input = view.container.querySelector<HTMLInputElement>('input[name="name"]');
    expect(input?.value).toBe('Operating account');
    expect(document.activeElement).toBe(input);
    const label = view.container.querySelector(`label[for="${input?.id}"]`);
    expect(label?.textContent).toBe('New name for Operating account');

    await click(button('Cancel', view.container));
    expect(view.container.querySelector('form')).toBeNull();

    await click(button('Rename Operating account'));
    await fill(view.container.querySelector('input[name="name"]'), 'Payroll');
    await submit(view.container);
    await settle();

    expect(mocks.renameCompanyBankAccount).toHaveBeenCalledWith(
      session,
      BANK,
      { name: 'Payroll' },
      expect.any(String),
    );
    expect(mocks.success).toHaveBeenCalledWith('Renamed to Payroll.');
    expect(view.container.querySelector('form')).toBeNull();
    await view.unmount();
  });
});

describe('add expense account', () => {
  it('shows a duplicate code under Code and keeps what was typed', async () => {
    mocks.createExpenseAccount.mockRejectedValue(new ApiError(409, 'conflict'));
    const view = await mountForm(<AddExpenseAccountForm idempotencyKey={KEY} />);
    await fill(view.container.querySelector('input[name="code"]'), '5100');
    await fill(view.container.querySelector('input[name="name"]'), 'Office supplies');
    await submit(view.container);
    await settle();

    const code = view.container.querySelector<HTMLInputElement>('input[name="code"]');
    expect(code?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = code?.getAttribute('aria-describedby') ?? '';
    const messages = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(messages).toContain('That code is already used');
    expect(code?.value).toBe('5100');
    expect(view.container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Office supplies',
    );
    await view.unmount();
  });

  it('adds and confirms with a toast', async () => {
    mocks.createExpenseAccount.mockResolvedValue({ id: EXPENSE, code: '5100', name: 'Office' });
    const view = await mountForm(<AddExpenseAccountForm idempotencyKey={KEY} />);
    await fill(view.container.querySelector('input[name="code"]'), '5100');
    await fill(view.container.querySelector('input[name="name"]'), 'Office');
    await submit(view.container);
    await settle();

    expect(mocks.createExpenseAccount).toHaveBeenCalledWith(
      session,
      { code: '5100', name: 'Office' },
      KEY,
    );
    expect(mocks.success).toHaveBeenCalledWith('Added 5100 Office.');
    await view.unmount();
  });
});

describe('one Idempotency-Key per opening of a form', () => {
  it('sends the same key again after a refused add, then a new one after an add that saved', async () => {
    mocks.createExpenseAccount
      .mockRejectedValueOnce(new ApiError(502, 'down'))
      .mockResolvedValue({ id: EXPENSE, code: '5100', name: 'Office' });
    const view = await mountForm(<AddExpenseAccountForm idempotencyKey={KEY} />);
    await fill(view.container.querySelector('input[name="code"]'), '5100');
    await fill(view.container.querySelector('input[name="name"]'), 'Office');
    await submit(view.container);
    await settle();
    await fill(view.container.querySelector('input[name="code"]'), '5100');
    await fill(view.container.querySelector('input[name="name"]'), 'Office');
    await submit(view.container);
    await settle();

    // A retry after a lost answer reaches the API under the key of the first try, so it writes once.
    expect(mocks.createExpenseAccount.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      KEY,
      KEY,
    ]);

    // The add saved: the next account is a different request and gets its own key.
    await fill(view.container.querySelector('input[name="code"]'), '5200');
    await fill(view.container.querySelector('input[name="name"]'), 'Travel');
    await submit(view.container);
    await settle();
    const third = mocks.createExpenseAccount.mock.calls[2]?.[2] as string;
    expect(third).not.toBe(KEY);
    expect(third).toMatch(/^[0-9a-f-]{36}$/);
    await view.unmount();
  });

  it('keeps the key of a retire across a refused try', async () => {
    mocks.retireCompanyBankAccount.mockRejectedValue(new ApiError(502, 'down'));
    const view = await mountForm(<RetireButton kind="bank" id={BANK} label="Operating account" />);
    await click(button('Retire Operating account'));
    // A refused retire leaves the dialog open: pressing the button again is the retry.
    for (let i = 0; i < 2; i += 1) {
      await click(dialogButton('Retire bank account'));
      await settle();
    }
    const keys = mocks.retireCompanyBankAccount.mock.calls.map((call) => call[2] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await view.unmount();
  });
});
