// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm, typeKeys } from '@/test/form-interactions';
import { ScoreForm } from './decision-forms';
import { QuoteForm } from './quote-form';

const RFQ = '11111111-1111-4111-8111-111111111111';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountQuote(quantity = '1') {
  mounted = await mountForm(
    <QuoteForm
      action={vi.fn()}
      idempotencyKey="key"
      rfqId={RFQ}
      mode="record"
      vendors={[{ id: 'vendor', name: 'Vendor' }]}
      prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity }]}
      taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
      enabledCurrencies={['NPR']}
      cancelHref={`/procurement/rfqs/${RFQ}`}
      reloadHref={`/procurement/rfqs/${RFQ}/quotations/new`}
    />,
  );
}

/** The posted (hidden) field and the visible box next to it. */
function numberField(name: string) {
  const posted = document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  if (!posted) throw new Error(`No hidden field ${name}`);
  const box = posted.parentElement!.querySelector<HTMLInputElement>('input:not([type="hidden"])');
  if (!box) throw new Error(`No visible box for ${name}`);
  return { posted, box };
}

describe('quotation entry boxes', () => {
  it('picks the valid-until date with the calendar and posts it as validUntil', async () => {
    await mountQuote();
    const panel = document.querySelector('form')!;
    expect(panel.querySelector('button[aria-label="Calendar"]')).not.toBeNull();
    // The picker's hidden input posts the name, so the form field is unchanged; it is not a visible box.
    const posted = [...panel.querySelectorAll<HTMLInputElement>('input[name="validUntil"]')].filter(
      (input) => input.form === panel,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.hidden).toBe(true);
    expect(new FormData(panel).get('validUntil')).toBe('');
  });

  it('groups a typed quantity and steps it with both buttons, posting the plain number', async () => {
    await mountQuote();
    const { posted, box } = numberField('lines.0.quantity');
    expect(box.getAttribute('role')).toBe('spinbutton');
    await act(() => Promise.resolve(box.focus()));
    box.setSelectionRange(0, box.value.length);
    await typeKeys(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(posted.value).toBe('1250000');

    const increase = document.querySelector('button[aria-label="Increase quantity"]');
    const decrease = document.querySelector('button[aria-label="Decrease quantity"]');
    await click(increase);
    expect(box.value).toBe('12,50,001');
    expect(posted.value).toBe('1250001');
    await click(decrease);
    await click(decrease);
    expect(box.value).toBe('12,49,999');
    expect(posted.value).toBe('1249999');
  });

  it('shows the unit price with the currency and grouping, and delivery days as whole days', async () => {
    await mountQuote();
    const price = numberField('lines.0.unitPrice');
    await typeKeys(price.box, '450000.5');
    expect(price.box.value).toBe('4,50,000.5');
    expect(price.posted.value).toBe('450000.5');
    expect(price.box.parentElement?.textContent).toContain('NPR');

    const days = numberField('deliveryDays');
    await typeKeys(days.box, '14.5');
    expect(days.box.value).toBe('145');
    expect(days.posted.value).toBe('145');
  });
});

describe('score box', () => {
  it('refuses a score above 100 and keeps what was typed before it', async () => {
    mounted = await mountForm(
      <ScoreForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId={RFQ}
        quotationId="quotation"
        vendorName="Vendor"
        held={[]}
        reloadHref={`/procurement/rfqs/${RFQ}`}
      />,
    );
    const { posted, box } = numberField('scores.0.score');
    await typeKeys(box, '101');
    expect(box.value).toBe('10');
    expect(posted.value).toBe('10');
    expect(box.parentElement!.parentElement!.querySelector('[role="status"]')?.textContent).toMatch(
      /100/,
    );
  });
});
