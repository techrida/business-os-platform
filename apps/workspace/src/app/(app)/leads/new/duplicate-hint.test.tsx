// @vitest-environment jsdom
// The new-lead form's duplicate hint (F1-Q54 a) around the real LeadForm: it appears after the typing pause when the
// lookup finds a match, links the match, disappears when nothing matches, shows nothing when the lookup fails, and
// never disables or blocks Save.
import type { LeadDuplicateMatch } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LeadForm } from '@/components/p2/crm/lead-form';
import type { FormAction } from '@/components/p2/crm/types';
import { choose, click, fill, mountForm } from '@/test/form-interactions';

import type { DuplicateFetcher } from '../_lib/use-duplicate-hint';
import { LeadDuplicateHint } from './duplicate-hint';

const LEAD = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const MATCHES: LeadDuplicateMatch[] = [
  { kind: 'customer', id: CUSTOMER, label: 'Himalayan Traders Pvt. Ltd.', matchedOn: ['company'] },
  { kind: 'lead', id: LEAD, label: 'Himalayan Traders (LD-2083/84-00001)', matchedOn: ['company'] },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  vi.useRealTimers();
});

async function mount(fetcher: DuplicateFetcher) {
  const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
  const mounted = await mountForm(
    <LeadDuplicateHint fetcher={fetcher}>
      <LeadForm
        action={action}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={[]}
        enabledCurrencies={['NPR']}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
      />
    </LeadDuplicateHint>,
  );
  const { container } = mounted;
  await fill(container.querySelector('[name="title"]'), 'Dispatch automation');
  await choose(container, 'source', 'Referral');
  await fill(container.querySelector('[name="contactName"]'), 'Su');
  // Only the debounce timers are faked; React's scheduling stays real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const region = () => container.querySelector('[data-duplicate-hint]');
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');
  const pause = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  return { ...mounted, action, region, submitButton, pause };
}

it('shows the hint with links after the typing pause, and never blocks Save', async () => {
  const fetcher = vi.fn<DuplicateFetcher>().mockResolvedValue(MATCHES);
  const m = await mount(fetcher);
  try {
    expect(m.region()?.getAttribute('aria-live')).toBe('polite');
    await fill(m.container.querySelector('[name="companyName"]'), 'Him');
    await m.pause(200);
    await fill(m.container.querySelector('[name="companyName"]'), 'Himalayan');
    await m.pause(399);
    expect(fetcher).not.toHaveBeenCalled();
    await m.pause(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The short contact name ("Su") is not looked up; the earlier keystroke's lookup never ran.
    expect(fetcher.mock.calls[0]![0].toString()).toBe('company=Himalayan');

    expect(m.region()?.textContent).toContain('A similar lead or customer exists');
    const links = Array.from(m.region()!.querySelectorAll('a')).map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Himalayan Traders Pvt. Ltd.', `/customers/${CUSTOMER}`],
      ['Himalayan Traders (LD-2083/84-00001)', `/leads/${LEAD}`],
    ]);
    // The typed value survives the hint appearing.
    expect(m.container.querySelector<HTMLInputElement>('[name="companyName"]')?.value).toBe(
      'Himalayan',
    );

    expect(m.submitButton()?.disabled).toBe(false);
    await fill(m.container.querySelector('[name="contactName"]'), 'Sunita Shrestha');
    await click(m.submitButton());
    expect(m.action).toHaveBeenCalledTimes(1);
  } finally {
    await m.unmount();
  }
});

it('hides the hint when the next lookup finds nothing, and when the field gets too short', async () => {
  const fetcher = vi
    .fn<DuplicateFetcher>()
    .mockResolvedValueOnce(MATCHES)
    .mockResolvedValueOnce([])
    .mockResolvedValue(MATCHES);
  const m = await mount(fetcher);
  try {
    await fill(m.container.querySelector('[name="companyName"]'), 'Himalayan');
    await m.pause(400);
    expect(m.region()?.textContent).toContain('A similar lead or customer exists');

    await fill(m.container.querySelector('[name="companyName"]'), 'Zyxwv Unique');
    await m.pause(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(m.region()?.textContent).toBe('');

    await fill(m.container.querySelector('[name="companyName"]'), 'Himalayan');
    await m.pause(400);
    expect(m.region()?.textContent).toContain('A similar lead or customer exists');
    await fill(m.container.querySelector('[name="companyName"]'), 'Hi');
    expect(m.region()?.textContent).toBe('');
  } finally {
    await m.unmount();
  }
});

it('shows nothing when the lookup fails, and Save still works', async () => {
  const fetcher = vi.fn<DuplicateFetcher>().mockRejectedValue(new Error('502'));
  const m = await mount(fetcher);
  try {
    await fill(m.container.querySelector('[name="email"]'), 'buyer@himalayan.example');
    await m.pause(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(m.region()?.textContent).toBe('');
    expect(m.submitButton()?.disabled).toBe(false);
    await fill(m.container.querySelector('[name="contactName"]'), 'Sunita Shrestha');
    await click(m.submitButton());
    expect(m.action).toHaveBeenCalledTimes(1);
  } finally {
    await m.unmount();
  }
});

it('cancels a lookup in flight when typing goes on, so its late answer never shows', async () => {
  let release: (value: LeadDuplicateMatch[]) => void = () => undefined;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<DuplicateFetcher>((_query, signal) => {
    signals.push(signal);
    return signals.length === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve([]);
  });
  const m = await mount(fetcher);
  try {
    await fill(m.container.querySelector('[name="phone"]'), '980-111 2233');
    await m.pause(400);
    await fill(m.container.querySelector('[name="phone"]'), '980-111 2234');
    expect(signals[0]?.aborted).toBe(true);
    await m.pause(400);
    await act(async () => {
      release(MATCHES);
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(m.region()?.textContent).toBe('');
  } finally {
    await m.unmount();
  }
});
