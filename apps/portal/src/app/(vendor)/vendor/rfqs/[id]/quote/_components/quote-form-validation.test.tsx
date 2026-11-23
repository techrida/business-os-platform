// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountNode, pickDate } from '@/test/number-entry';

const submit = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions', () => ({ submitQuoteAction: submit }));

const { QuoteForm } = await import('./quote-form');

let mounted: Awaited<ReturnType<typeof mountNode>>;
afterEach(async () => {
  await mounted.unmount();
  submit.mockReset();
});

describe('QuoteForm without the browser check', () => {
  it('shows a message under a past "valid until" date and does not call the action', async () => {
    mounted = await mountNode(
      <QuoteForm
        idempotencyKey="7c9e6679-7425-40de-944b-e07fc1f90ae7"
        rfqId="1f8fad5b-d9cb-469f-a165-70867728950e"
        today="2026-11-10"
        currencies={['NPR', 'USD']}
      />,
    );
    const { container } = mounted;
    await pickDate(container, 'validUntil', '2026-11-09');

    const form = container.querySelector('form')!;
    await act(() =>
      Promise.resolve(form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))),
    );
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    expect(container.textContent).toContain('Enter today or a later date, or leave it empty.');
    expect(submit).not.toHaveBeenCalled();
  }, 15_000);
});
