import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
    // Old code put the name on the typed text box itself, with no currency inside it.
    expect(box).not.toContain('name=');
    expect(html).toContain(`<input type="hidden" name="amount:${INVOICE_ID}" value=""/>`);
    const prefixId = /aria-describedby="([^"\s]+)/.exec(box ?? '')?.[1];
    expect(html).toContain(`id="${prefixId}"`);
    expect(new RegExp(`id="${prefixId}"[^>]*>USD<`).test(html)).toBe(true);
  });

  it('carries the payment id and the page key, and shows no total or remaining check of its own', () => {
    const html = render();
    expect(html).toContain(`name="paymentId" value="${PAYMENT_ID}"`);
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain('Allocate payment');
    expect(html).not.toMatch(/exceeds|too much|total allocated/i);
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
