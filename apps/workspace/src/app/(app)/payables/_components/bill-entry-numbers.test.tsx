// @vitest-environment jsdom
// The number and date boxes of the bill entry form: the line quantity and unit price are grouped number boxes that
// post plain digits, and the invoice date is a picker that offers no day after today in the tenant's calendar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm, paste, typeKeys } from '@/test/form-interactions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));
import { BillEntryForm } from './bill-entry-form';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

const mount = (over: Partial<Parameters<typeof BillEntryForm>[0]> = {}) =>
  mountForm(
    <BillEntryForm
      idempotencyKey="key"
      orderLines={[]}
      taxCodes={[]}
      cancelHref="/payables/bills"
      reloadHref="/payables/bills/new"
      {...over}
    />,
  );

/** The control a visible label names, found through its `for`, as a person or screen reader finds it. */
function labelled(container: HTMLElement, text: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === text,
  );
  const control = label ? document.getElementById(label.htmlFor) : null;
  if (!(control instanceof HTMLInputElement)) throw new Error(`No input labelled ${text}`);
  return control;
}

const posted = (container: HTMLElement, name: string) =>
  new FormData(container.querySelector('form')!).get(name);

describe('the bill line number boxes', () => {
  it('posts a pasted grouped unit price as plain digits', async () => {
    mounted = await mount();
    const { container } = mounted;
    const price = labelled(container, 'Unit price');
    await paste(price, '12,50,000.00');
    expect(price.value).toBe('12,50,000.00');
    expect(posted(container, 'line:0:unitPrice')).toBe('1250000.00');
  });

  it('groups a typed quantity and steps it with both buttons', async () => {
    mounted = await mount();
    const { container } = mounted;
    const quantity = labelled(container, 'Quantity');
    await typeKeys(quantity, '1250000');
    expect(quantity.value).toBe('12,50,000');
    expect(posted(container, 'line:0:quantity')).toBe('1250000');

    const line = quantity.closest('fieldset')!;
    await click(line.querySelector('button[aria-label="Increase quantity"]'));
    expect(quantity.value).toBe('12,50,001');
    expect(posted(container, 'line:0:quantity')).toBe('1250001');
    await click(line.querySelector('button[aria-label="Decrease quantity"]'));
    await click(line.querySelector('button[aria-label="Decrease quantity"]'));
    expect(quantity.value).toBe('12,49,999');
    expect(posted(container, 'line:0:quantity')).toBe('1249999');
  });
});

describe('the invoice date of a keyed bill', () => {
  it('is a date picker that starts at today and offers no later day', async () => {
    // The 15th, so the 14th and the 16th both sit in the month the calendar opens on.
    mounted = await mount({ entry: { vendors: [], today: '2026-11-15' } });
    const { container } = mounted;
    expect(posted(container, 'invoiceDate')).toBe('2026-11-15');
    const trigger = container.querySelector('button[aria-label="Calendar"]');
    expect(trigger).not.toBeNull();
    await click(trigger);
    const disabledCell = (day: string) =>
      Array.from(document.querySelectorAll('[role="gridcell"]')).find(
        (c) => c.textContent?.trim() === day && c.querySelector('[aria-disabled="true"]') !== null,
      );
    expect(disabledCell('16')).toBeDefined();
    expect(disabledCell('14')).toBeUndefined();
  });
});
