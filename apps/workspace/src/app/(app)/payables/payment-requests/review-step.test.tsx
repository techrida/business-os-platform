// @vitest-environment jsdom
// The review step before a payment request is created (FX6 #4): payee, paying account, currency and the amount in
// figures and in words, then Confirm. Back and Escape return to the form with every value kept; nothing is sent
// until Confirm, and the server action still checks everything.
import type { CompanyBankAccount } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PaymentRequestItem } from '@/lib/api-payables';
import { click, fill, mountForm } from '@/test/form-interactions';

const actions = vi.hoisted(() => ({
  createPaymentRequestAction: vi.fn((prev: unknown, _form: FormData) => Promise.resolve(prev)),
  submitPaymentRequestAction: vi.fn(),
  cancelPaymentRequestAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('./actions', () => actions);

const { PaymentRequestEntry } = await import('./forms');

const VENDOR = '11111111-1111-4111-8111-111111111111';
const BILL: PaymentRequestItem = {
  openItemId: '33333331-3333-4333-8333-333333333333',
  vendorPartyId: VENDOR,
  vendorName: 'Himal Supplies',
  vendorBillId: '44444441-4444-4444-8444-444444444444',
  billNumber: 'BILL-1',
  vendorInvoiceNo: 'INV-1',
  currency: 'NPR',
  openAmount: '100000.000',
  claimedAmount: '0.000',
  // Numeric columns arrive at full scale: the form and the review show 1,00,000.00.
  availableAmount: '100000.000',
};
const ACCOUNT: CompanyBankAccount = {
  id: '55555551-5555-4555-8555-555555555555',
  name: 'Operating',
  bankName: 'Nabil Bank',
  last4: '1234',
  currency: 'NPR',
  status: 'active',
  retiredAt: null,
};

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  actions.createPaymentRequestAction.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const form = () => mounted!.container.querySelector('form')!;
const posted = () => Object.fromEntries(new FormData(form()).entries());

// The input types whose presence stops a form without a submit button from submitting on Enter (HTML implicit submission).
const BLOCKS_IMPLICIT_SUBMISSION = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);
/**
 * Enter in a text field the way a browser handles it (user-event is not a dependency here): keydown, then, unless
 * a handler cancelled it, a click on the form's default button, the first submit button in `form.elements`, which
 * includes a button outside the form that names it with `form=`. A disabled default button does nothing. With no
 * submit button the form is submitted only when it has a single blocking field.
 */
async function pressEnter(field: HTMLInputElement) {
  await act(async () => {
    field.focus();
    const proceed = field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    if (proceed) {
      const owner = field.form!;
      const controls = [...owner.elements];
      const submitter = controls.find(
        (el): el is HTMLButtonElement | HTMLInputElement =>
          (el instanceof HTMLButtonElement && el.type === 'submit') ||
          (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image')),
      );
      if (submitter !== undefined) {
        if (!submitter.disabled) submitter.click();
      } else if (
        controls.filter(
          (el) => el instanceof HTMLInputElement && BLOCKS_IMPLICIT_SUBMISSION.has(el.type),
        ).length === 1
      ) {
        owner.requestSubmit();
      }
    }
    await Promise.resolve();
  });
}
/** The visible text box a field's label names (role textbox), never the hidden input that posts the value. */
function textboxByLabel(name: string): HTMLInputElement {
  const label = [...form().querySelectorAll('label')].find(
    (element) => element.textContent?.trim() === name,
  );
  const box = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(box instanceof HTMLInputElement) || box.type !== 'text') {
    throw new Error(`No text box labelled "${name}"`);
  }
  return box;
}
const amountField = () => textboxByLabel('Amount 1');

/** A form started from the bill's "Request payment" link, with the paying account picked. */
async function filledForm() {
  mounted = await mountForm(
    <PaymentRequestEntry
      idempotencyKey="key"
      items={[BILL]}
      bankAccounts={[ACCOUNT]}
      start={BILL}
    />,
  );
  const bank = mounted.container
    .querySelector('input[type="hidden"][name="fromBankAccountId"]')!
    .parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  bank.focus();
  await fill(bank, '1234');
  // Enter that chooses the account is the combobox's own: it must not reach the opener as a submit.
  await pressEnter(bank);
  await flush();
  expect(dialog()).toBeNull();
  expect(actions.createPaymentRequestAction).not.toHaveBeenCalled();
  expect(posted()['fromBankAccountId']).toBe(ACCOUNT.id);
}

async function openReview() {
  const opener = button('Review request');
  opener.focus();
  await click(opener);
  await flush();
  return opener;
}

it('shows the payee, account, currency, bill and the amount in figures and words before anything is sent', async () => {
  await filledForm();
  expect(posted()['allocation:0:amount']).toBe('100000.00');
  await openReview();

  const shown = dialog();
  expect(shown).not.toBeNull();
  const labelledBy = shown!.getAttribute('aria-labelledby');
  expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe(
    'Review the payment request',
  );
  const text = shown!.textContent ?? '';
  expect(text).toContain('Himal Supplies');
  expect(text).toContain('Operating · Nabil Bank ····1234 · NPR');
  expect(text).toContain('BILL-1 · INV-1');
  expect(text).toContain('NPR 1,00,000.00');
  expect(text).toContain('One Lakh Rupees Only');
  expect(text).toContain('No purchase order');
  // Old code sent the form straight from the heading button.
  expect(actions.createPaymentRequestAction).not.toHaveBeenCalled();
});

it('sends the form once on Create draft request, with the values the review showed', async () => {
  await filledForm();
  await openReview();
  await click(button('Create draft request'));
  await flush();

  expect(dialog()).toBeNull();
  expect(actions.createPaymentRequestAction).toHaveBeenCalledTimes(1);
  const sent = actions.createPaymentRequestAction.mock.calls[0]![1];
  expect(sent.get('vendorPartyId')).toBe(VENDOR);
  expect(sent.get('fromBankAccountId')).toBe(ACCOUNT.id);
  expect(sent.get('currency')).toBe('NPR');
  expect(sent.get('allocation:0:openItemId')).toBe(BILL.openItemId);
  expect(sent.get('allocation:0:amount')).toBe('100000.00');
});

it('goes back to the form with every value kept and focus on the opener, after Back and after Escape', async () => {
  await filledForm();
  const before = posted();
  const opener = await openReview();
  expect(dialog()?.contains(document.activeElement)).toBe(true);

  await click(button('Back'));
  await flush();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(posted()).toEqual(before);

  await openReview();
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await Promise.resolve();
  });
  await flush();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(posted()).toEqual(before);
  expect(actions.createPaymentRequestAction).not.toHaveBeenCalled();
});

it('opens the review, not a send, on Enter in the amount field; Confirm then sends once and Escape returns focus to the opener', async () => {
  await filledForm();
  // Old code: the opener was not a submit button, so with two text fields Enter submitted nothing.
  await pressEnter(amountField());
  await flush();
  expect(dialog()).not.toBeNull();
  expect(actions.createPaymentRequestAction).not.toHaveBeenCalled();

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await Promise.resolve();
  });
  await flush();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button('Review request'));
  expect(posted()['allocation:0:amount']).toBe('100000.00');

  await pressEnter(amountField());
  await flush();
  await click(button('Create draft request'));
  await flush();
  expect(dialog()).toBeNull();
  expect(actions.createPaymentRequestAction).toHaveBeenCalledTimes(1);
  expect(actions.createPaymentRequestAction.mock.calls[0]![1].get('allocation:0:amount')).toBe(
    '100000.00',
  );
});

it('makes the opener the submit button of the form it reviews', async () => {
  await filledForm();
  const opener = button('Review request');
  expect(opener.type).toBe('submit');
  expect(opener.form).toBe(form());
});

it('shows the request date as the Kathmandu day the request is created', async () => {
  // 18:30 UTC on 21 Nov is 00:15 on 22 Nov in Kathmandu (UTC+05:45).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-21T18:30:00Z'));
  await filledForm();
  await openReview();
  const text = dialog()?.textContent ?? '';
  expect(text).toContain('Request date');
  expect(text).toContain('22 Nov 2026');
  expect(text).toContain('The day the request is created');
});

it('lets the server name the fields when the request is incomplete, without a review', async () => {
  mounted = await mountForm(
    <PaymentRequestEntry
      idempotencyKey="key"
      items={[BILL]}
      bankAccounts={[ACCOUNT]}
      start={BILL}
    />,
  );
  // No paying account chosen: the contract refuses it, so there is nothing to review.
  await click(button('Review request'));
  await flush();
  expect(dialog()).toBeNull();
  expect(actions.createPaymentRequestAction).toHaveBeenCalledTimes(1);
});
