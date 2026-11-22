// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boxOf, fill, mountNode, paste, pickDate, posted } from '@/test/number-entry';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { QuoteForm } = await import('./quote-form');

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RFQ = '1f8fad5b-d9cb-469f-a165-70867728950e';
let mounted: Awaited<ReturnType<typeof mountNode>>;

async function mount() {
  mounted = await mountNode(
    <QuoteForm idempotencyKey={KEY} rfqId={RFQ} today="2026-11-10" currencies={['NPR', 'USD']} />,
  );
  return mounted.container;
}

afterEach(async () => {
  await mounted.unmount();
});

describe('QuoteForm numbers', () => {
  it('groups the total as it is typed and posts it plain', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total of your quotation');
    await fill(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(posted(container, 'total')).toBe('1250000');
  });

  it('takes a pasted `12,50,000.00` and posts 1250000.00', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total of your quotation');
    await paste(box, '12,50,000.00');
    expect(posted(container, 'total')).toBe('1250000.00');
  });

  it('keeps delivery days to whole digits, at most 1000, with no stepper', async () => {
    const container = await mount();
    const days = boxOf(container, 'Delivery time in days (optional)');
    await fill(days, '14');
    expect(posted(container, 'deliveryDays')).toBe('14');
    await fill(days, '14.5');
    expect(days.value).toBe('14');
    await fill(days, '1001');
    expect(days.value).toBe('14');
    expect(days.getAttribute('inputmode')).toBe('numeric');
    // Days are not a quantity: nothing to step.
    expect(container.querySelector('button[aria-label*="crease"]')).toBeNull();
  });

  it('leaves delivery days empty when nothing is typed, so the server omits it', async () => {
    const container = await mount();
    expect(posted(container, 'deliveryDays')).toBe('');
  });
});

describe('QuoteForm valid-until date', () => {
  it('is the app date picker, posts nothing until picked, and the browser blocks a day before today', async () => {
    const container = await mount();
    expect(container.querySelector('button[aria-label="Calendar"]')).not.toBeNull();
    expect(posted(container, 'validUntil')).toBe('');
    await pickDate(container, 'validUntil', '2026-11-12');
    expect(posted(container, 'validUntil')).toBe('2026-11-12');
    // The input the form posts (the picker's other one has form="" and posts nothing).
    const valid = () =>
      container
        .querySelector<HTMLInputElement>('input[name="validUntil"]:not([form=""])')!
        .checkValidity();
    expect(valid()).toBe(true);
    await pickDate(container, 'validUntil', '2026-11-09');
    expect(valid()).toBe(false);
  }, 15_000);
});
