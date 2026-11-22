// @vitest-environment jsdom
// jsdom for the running-total tests that type into the boxes; the rest render static markup.
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import { INVOICE_ID, PAYMENT_ID } from '../_lib/fixtures';

import { INVOICE_2_ID, settlement } from './allocate-fixtures';
import { AllocatePanel, type AllocatePanelProps } from './allocate-panel';
import { DeallocateDialog } from './deallocate-dialog';

// The panel imports the server actions, which import server-only modules.
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// Include the dialog portal in the static render to verify its form fields and action footer.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} open />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function render(over: Partial<AllocatePanelProps> = {}): string {
  return renderToStaticMarkup(
    <AllocatePanel
      paymentId={PAYMENT_ID}
      currency="NPR"
      remaining="250000.00"
      advance="1234567.00"
      items={[settlement()]}
      idempotencyKey={KEY}
      reloadHref={`/payments/${PAYMENT_ID}`}
      {...over}
    />,
  );
}

describe('allocate panel', () => {
  it('lists each open invoice by its number with the open amount the server sent', () => {
    const html = render({
      items: [
        settlement(),
        settlement({
          invoiceId: INVOICE_2_ID,
          number: 'DN-2083/84-00002',
          openAmount: '12000.50',
          total: '12000.50',
          allocatedAmount: '0.00',
          settlement: 'unpaid',
        }),
      ],
    });
    expect(html).toContain('Allocate this payment');
    expect(html).toContain('INV-2083/84-00007');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('DN-2083/84-00002');
    expect(html).toContain('NPR 12,000.50');
    expect(html).toContain(`href="/invoices/${INVOICE_ID}"`);
  });

  it('gives each amount a name that carries the invoice id and a label that names the invoice', () => {
    const html = render();
    expect(html).toContain(`name="amount:${INVOICE_ID}"`);
    expect(html).toContain('aria-label="Amount to allocate to INV-2083/84-00007"');
    expect(html).toContain('inputMode="decimal"');
  });

  it('takes each amount in a money box in the payment currency that posts through a hidden input', () => {
    const html = render({ currency: 'USD' });
    const box = /<input[^>]*aria-label="Amount to allocate to INV-2083\/84-00007"[^>]*>/.exec(
      html,
    )?.[0];
    expect(box).toBeDefined();
    // Until hydration the typed box carries the name, so an early post is not the stale server value.
    expect(box).toContain(`name="amount:${INVOICE_ID}"`);
    expect(html).not.toContain(`<input type="hidden" name="amount:${INVOICE_ID}"`);
    const prefixId = /aria-describedby="([^"\s]+)/.exec(box ?? '')?.[1];
    expect(html).toContain(`id="${prefixId}"`);
    expect(new RegExp(`id="${prefixId}"[^>]*>USD<`).test(html)).toBe(true);
  });

  it('carries the payment id and the page key, and starts the running total at nothing', () => {
    const html = render();
    expect(html).toContain(`name="paymentId" value="${PAYMENT_ID}"`);
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain('Allocate payment');
    expect(html).toMatch(/role="status"[^>]*>Allocated NPR 0.00 of NPR 2,50,000.00 remaining</);
  });

  it('shows what is left on the payment and the customer advance, both from the server', () => {
    const html = render();
    expect(html).toContain('Left on this payment');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('Customer advance in NPR');
    expect(html).toContain('NPR 12,34,567.00');
  });

  it('says so when the advance could not be read, and still offers the form', () => {
    const html = render({ advance: null });
    expect(html).toContain('Could not be loaded');
    expect(html).toContain(`name="amount:${INVOICE_ID}"`);
  });

  it('says so when the open invoices could not be read, without a form', () => {
    const html = render({ items: null });
    expect(html).toContain('The open invoices could not be loaded');
    expect(html).toContain('Reload this payment');
    expect(html).not.toContain('<form');
  });

  it('says there is nothing to allocate to when no invoice is open, without a form', () => {
    const html = render({ items: [] });
    expect(html).toContain('no open invoices in NPR');
    expect(html).not.toContain('<form');
  });

  it('marks an overdue invoice and an invoice with no due date', () => {
    const html = render({
      items: [
        settlement({ daysOverdue: 12, settlement: 'overdue' }),
        settlement({ invoiceId: INVOICE_2_ID, number: 'INV-2', dueDate: null }),
      ],
    });
    expect(html).toContain('12 days overdue');
    expect(html).toContain('No due date');
  });

  it('keeps a very long invoice number inside its cell', () => {
    const html = render({ items: [settlement({ number: `INV-${'9'.repeat(80)}` })] });
    expect(html).toContain('9'.repeat(80));
  });
});

describe('allocate panel running total', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const SECOND = settlement({
    invoiceId: INVOICE_2_ID,
    number: 'DN-2083/84-00002',
    openAmount: '12000.50',
    total: '12000.50',
    allocatedAmount: '0.00',
    settlement: 'unpaid',
  });

  const mount = (over: Partial<AllocatePanelProps> = {}) =>
    mountForm(
      <AllocatePanel
        paymentId={PAYMENT_ID}
        currency="NPR"
        remaining="250000.00"
        advance="0.00"
        items={[settlement(), SECOND]}
        idempotencyKey={KEY}
        reloadHref={`/payments/${PAYMENT_ID}`}
        {...over}
      />,
    );

  const box = (root: HTMLElement, number: string) =>
    root.querySelector<HTMLInputElement>(`input[aria-label="Amount to allocate to ${number}"]`);
  const totalLine = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('[role="status"]')).find((el) =>
      el.textContent?.startsWith('Allocated'),
    )?.textContent;
  const allocateButton = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Allocate payment',
    );

  it('adds the amounts up as they are typed, against what is left on the payment', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      // Old code had no total line at all.
      expect(totalLine(root)).toBe('Allocated NPR 0.00 of NPR 2,50,000.00 remaining');
      // Nothing typed is not blocked here: the server keeps refusing an empty allocation.
      expect(allocateButton(root)?.disabled).toBe(false);
      await fill(box(root, 'INV-2083/84-00007'), '1000');
      expect(totalLine(root)).toBe('Allocated NPR 1,000.00 of NPR 2,50,000.00 remaining');
      await fill(box(root, 'DN-2083/84-00002'), '250.50');
      expect(totalLine(root)).toBe('Allocated NPR 1,250.50 of NPR 2,50,000.00 remaining');
    } finally {
      await mounted.unmount();
    }
  });

  it('marks a row above its invoice open amount and keeps the button off', async () => {
    const mounted = await mount({ remaining: '500000.00' });
    try {
      const root = mounted.container;
      const first = box(root, 'INV-2083/84-00007');
      await fill(first, '250000.01');
      // Old code left the button on and the row unmarked; only the server refused it.
      expect(allocateButton(root)?.disabled).toBe(true);
      expect(first?.getAttribute('aria-invalid')).toBe('true');
      const message = document.getElementById(`amount-${INVOICE_ID}-error`);
      expect(message?.textContent).toBe('More than the NPR 2,50,000.00 open on this invoice.');
      expect(first?.getAttribute('aria-describedby')).toContain(`amount-${INVOICE_ID}-error`);
      // The other row is not blamed.
      expect(box(root, 'DN-2083/84-00002')?.getAttribute('aria-invalid')).toBeNull();
      await fill(first, '250000.00');
      expect(allocateButton(root)?.disabled).toBe(false);
      expect(document.getElementById(`amount-${INVOICE_ID}-error`)).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the button off and says by how much when the total passes what is left', async () => {
    const mounted = await mount({ remaining: '1000.00' });
    try {
      const root = mounted.container;
      await fill(box(root, 'INV-2083/84-00007'), '600');
      await fill(box(root, 'DN-2083/84-00002'), '400.01');
      expect(totalLine(root)).toBe(
        'Allocated NPR 1,000.01 of NPR 1,000.00 remaining. That is NPR 0.01 more than is left on this payment.',
      );
      expect(allocateButton(root)?.disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('allows a total exactly equal to what is left', async () => {
    const mounted = await mount({ remaining: '1000.00' });
    try {
      const root = mounted.container;
      await fill(box(root, 'INV-2083/84-00007'), '600');
      await fill(box(root, 'DN-2083/84-00002'), '400');
      expect(totalLine(root)).toBe('Allocated NPR 1,000.00 of NPR 1,000.00 remaining');
      expect(allocateButton(root)?.disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('adds fractions exactly, so 0.1 and 0.2 fill a 0.30 payment without passing it', async () => {
    const mounted = await mount({ remaining: '0.30' });
    try {
      const root = mounted.container;
      await fill(box(root, 'INV-2083/84-00007'), '0.1');
      await fill(box(root, 'DN-2083/84-00002'), '0.2');
      // In JS numbers 0.1 + 0.2 is 0.30000000000000004, which is more than 0.30.
      expect(totalLine(root)).toBe('Allocated NPR 0.30 of NPR 0.30 remaining');
      expect(allocateButton(root)?.disabled).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('deallocate dialog', () => {
  function dialog(): string {
    return renderToStaticMarkup(
      <DeallocateDialog
        paymentId={PAYMENT_ID}
        allocationId="77777777-7777-4777-8777-777777777777"
        label="INV-2083/84-00007"
        idempotencyKey={KEY}
        reloadHref={`/payments/${PAYMENT_ID}`}
      />,
    );
  }

  it('has a trigger that names the invoice, and a required reason', () => {
    const html = dialog();
    expect(html).toContain('Deallocate INV-2083/84-00007');
    expect(html).toContain('Reason for deallocating');
    expect(html).toMatch(/<textarea[^>]*required/);
    expect(html).toContain('name="allocationId" value="77777777-7777-4777-8777-777777777777"');
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
  });

  it('says what a deallocation does before asking for the reason', () => {
    expect(dialog()).toMatch(/reversal/i);
  });
});
