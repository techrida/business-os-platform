// @vitest-environment jsdom
// TR-Q12d: when the record action answers with earlier payments that carry the same bank reference,
// the form lists them and asks the person to confirm before the next submit records the payment.
// Driven through the real form and a stubbed action, with matches in the route's own shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

import { CUSTOMER_ID } from '../_lib/fixtures';

import type { RecordPaymentState } from './form-state';
import { PaymentForm } from './payment-form';

const mocks = vi.hoisted(() => ({
  action: vi.fn<(prev: RecordPaymentState, form: FormData) => Promise<RecordPaymentState>>(),
}));
vi.mock('./actions', () => ({ recordPaymentAction: mocks.action }));

const EARLIER = '55555555-5555-4555-8555-555555555555';
const OLDER = '66666666-6666-4666-8666-666666666666';

/** Two matches as GET /v1/payments/reference-matches answers them: newest first, amounts as strings. */
const matches: NonNullable<RecordPaymentState['referenceMatches']> = [
  {
    id: EARLIER,
    number: null,
    customerName: 'Everest Foods',
    receivedOn: '2026-11-05',
    amount: '250.50',
    currency: 'NPR',
    status: 'submitted',
  },
  {
    id: OLDER,
    number: 'RCPT-2083/84-00012',
    customerName: null,
    receivedOn: '2026-10-01',
    amount: '1200000.00',
    currency: 'USD',
    status: 'verified',
  },
];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = () =>
  mountForm(
    <PaymentForm
      idempotencyKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      today="2026-11-20"
      customers={[
        { id: CUSTOMER_ID, name: 'Everest Foods', number: 'CUST-0001', defaultCurrency: 'NPR' },
      ]}
      enabledCurrencies={['NPR', 'USD']}
      initialCustomerId={CUSTOMER_ID}
      reloadHref="/payments/new"
    />,
  );

describe('payment form, bank reference already recorded (TR-Q12d)', () => {
  it('lists the earlier payments with customer, date, amount and status, and sends the confirmation with the next submit', async () => {
    mocks.action.mockResolvedValueOnce({
      key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      referenceMatches: matches,
    });
    const mounted = await mount();
    try {
      await submit(mounted.container);
      // Nothing was recorded, so the warning takes focus and is announced from the button at the bottom.
      const warning = mounted.container.querySelector<HTMLElement>('[role="alert"]');
      expect(warning?.textContent).toContain(
        'A payment with this bank reference is already recorded',
      );
      expect(document.activeElement).toBe(warning);
      const items = [...(warning?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
      expect(items).toEqual([
        'Not yet numbered: NPR 250.50 from Everest Foods, received 05 Nov 2026 (Awaiting verification)',
        'RCPT-2083/84-00012: USD 1,200,000.00 from a customer you cannot see, received 01 Oct 2026 (Verified)',
      ]);
      const link = warning?.querySelector<HTMLAnchorElement>(`a[href="/payments/${EARLIER}"]`);
      expect(link?.textContent).toBe('Not yet numbered');
      expect(link?.target).toBe('_blank');

      const confirm = warning?.querySelector<HTMLInputElement>('input[name="referenceConfirmed"]');
      expect(confirm?.type).toBe('checkbox');
      expect(confirm?.checked).toBe(false);
      expect(confirm?.closest('label')?.textContent).toBe(
        'This is a different payment. Record it anyway.',
      );
      await click(confirm ?? null);
      mocks.action.mockResolvedValueOnce({ key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      await submit(mounted.container);
      const sent = mocks.action.mock.calls[1]?.[1];
      expect(sent?.get('referenceConfirmed')).toBe(`${EARLIER},${OLDER}`);
      expect(sent?.get('idempotencyKey')).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps what was typed through the warning, and a new set of matches starts unticked', async () => {
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mocks.action
      .mockResolvedValueOnce({ key, referenceMatches: [matches[0]!] })
      .mockResolvedValueOnce({ key, referenceMatches: matches });
    const mounted = await mount();
    try {
      const { container } = mounted;
      const amountFor = Array.from(container.querySelectorAll('label[for]'))
        .find((l) => l.textContent?.trim().startsWith('Amount received'))
        ?.getAttribute('for');
      // The visible box is the labelled one; the posted value sits on a hidden input named amount.
      await fill(container.querySelector(`input#${CSS.escape(amountFor ?? 'missing')}`), '250.50');
      await fill(container.querySelector('input[name="bankReference"]'), 'NIC 77812');
      await submit(container);
      await click(container.querySelector('input[name="referenceConfirmed"]'));
      // Someone recorded another payment with this reference in the meantime: the action warns again.
      await submit(container);
      const sent = mocks.action.mock.calls[1]?.[1];
      expect(sent?.get('referenceConfirmed')).toBe(EARLIER);
      expect(sent?.get('amount')).toBe('250.50');
      expect(sent?.get('bankReference')).toBe('NIC 77812');
      expect(sent?.get('customerId')).toBe(CUSTOMER_ID);

      const confirm = container.querySelector<HTMLInputElement>('input[name="referenceConfirmed"]');
      expect(confirm?.value).toBe(`${EARLIER},${OLDER}`);
      expect(confirm?.checked).toBe(false);
      expect(container.querySelector<HTMLInputElement>('input[name="amount"]')?.value).toBe(
        '250.50',
      );
      expect(container.querySelector<HTMLInputElement>('input[name="bankReference"]')?.value).toBe(
        'NIC 77812',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('shows no warning and no confirmation box before the action has found a match', async () => {
    const mounted = await mount();
    try {
      expect(mounted.container.textContent).not.toContain('already recorded');
      expect(mounted.container.querySelector('input[name="referenceConfirmed"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
