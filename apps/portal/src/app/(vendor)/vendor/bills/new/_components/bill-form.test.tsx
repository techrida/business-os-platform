// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boxOf, fill, mountNode, paste, posted, settle } from '@/test/number-entry';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { BillForm } = await import('./bill-form');

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
let mounted: Awaited<ReturnType<typeof mountNode>>;

async function mount() {
  mounted = await mountNode(
    <BillForm
      idempotencyKey={KEY}
      today="2026-11-10"
      orders={[]}
      initialOrderId=""
      currencies={['NPR', 'USD']}
    />,
  );
  return mounted.container;
}

afterEach(async () => {
  await mounted.unmount();
});

describe('BillForm total', () => {
  // Old code kept the pasted text as it came and left the cleaning to the server action.
  it('takes a pasted `12,50,000.00` as typed digits and posts 1250000.00', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total on your invoice');
    await paste(box, '12,50,000.00');
    expect(box.value).toBe('12,50,000.00');
    expect(posted(container, 'claimedTotal')).toBe('1250000');
  });

  it('groups what is typed and shows the amount in words', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total on your invoice');
    await fill(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(posted(container, 'claimedTotal')).toBe('1250000');
    expect(container.textContent).toMatch(/twelve lakh/i);
  });

  it('refuses a pasted `10 50`, says why, and keeps what was there', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total on your invoice');
    await fill(box, '500');
    await paste(box, '10 50');
    expect(box.value).toBe('500');
    expect(posted(container, 'claimedTotal')).toBe('500');
    const said = [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent);
    expect(said.some((t) => /space/i.test(t ?? ''))).toBe(true);
  });

  it('follows the chosen currency: prefix and grouping change, the posted value does not', async () => {
    const container = await mount();
    const box = boxOf(container, 'Total on your invoice');
    await fill(box, '1250000');
    expect(box.value).toBe('12,50,000');
    const prefix = () => box.parentElement?.textContent ?? '';
    expect(prefix()).toContain('NPR');
    const hidden = container.querySelector<HTMLInputElement>('input[name="currency"]')!;
    // The picker owns the currency state; drive it through its option as a person would.
    const trigger = hidden.parentElement!.querySelector<HTMLButtonElement>('button')!;
    await act(() => Promise.resolve(trigger.click()));
    const usd = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent?.trim() === 'USD',
    )!;
    await act(() => Promise.resolve(usd.click()));
    await settle();
    expect(prefix()).toContain('USD');
    expect(box.value).toBe('1,250,000.00');
    expect(posted(container, 'claimedTotal')).toBe('1250000');
  });
});
