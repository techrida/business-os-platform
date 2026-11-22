// @vitest-environment jsdom
// The new-lead form's duplicate hint (F1-Q54 a) around the real LeadForm, as the page renders it: it appears after the
// typing pause when the lookup finds a match, links the match, disappears when nothing matches, shows nothing when the
// lookup fails, and never disables or blocks Save. The phone it looks up is the primary row of the phone list, in
// E.164, reported by the form (no hidden `phone` input and no synthetic events).
import type { LeadDuplicateMatch } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, type Mock, vi } from 'vitest';

import type { FormAction } from '@/components/p2/crm/types';
import { choose, click, fill, mountForm, settle, typeKeys } from '@/test/form-interactions';

import { type DuplicateFetcher, duplicateQuery } from '../_lib/use-duplicate-hint';
import { NewLeadForm } from './new-lead-form';

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

/** The page's form and hint, with the title, source and a short contact name ("Su", never looked up) filled. */
async function mountPage(fetcher: DuplicateFetcher, delayMs?: number) {
  const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
  const mounted = await mountForm(
    <NewLeadForm
      fetcher={fetcher}
      delayMs={delayMs}
      action={action}
      sources={[{ label: 'Referral', value: 'referral' }]}
      owners={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  const { container } = mounted;
  await fill(container.querySelector('[name="title"]'), 'Dispatch automation');
  await choose(container, 'source', 'Referral');
  await fill(container.querySelector('[name="contactName"]'), 'Su');
  const region = () => container.querySelector('[data-duplicate-hint]');
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');
  const phone = (n: number) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`);
  return { ...mounted, action, region, submitButton, phone };
}

/** For the debounce cases: only the debounce timers are faked; React's scheduling stays real. */
async function mount(fetcher: DuplicateFetcher) {
  const mounted = await mountPage(fetcher);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pause = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  return { ...mounted, pause };
}

/** The phone list types through 0 ms caret timers, so its cases run on real timers with no typing pause. */
async function mountForPhones(fetcher: Mock<DuplicateFetcher>) {
  const mounted = await mountPage(fetcher, 0);
  /** Lets the 0 ms lookup timer run and its answer land. */
  const lookUp = async () => {
    await settle();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const phonesAsked = () => fetcher.mock.calls.map(([query]) => query.get('phone'));
  return { ...mounted, lookUp, phonesAsked };
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
    // A lead needs an email or a phone before it saves; the hint itself never stops it.
    await fill(m.container.querySelector('[name="email"]'), 'sunita@himalayan.example');
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

it('cancels a lookup in flight when the primary number changes, so its late answer never shows', async () => {
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
  const m = await mountForPhones(fetcher);
  try {
    await typeKeys(m.phone(1), '9801112233');
    await m.lookUp();
    expect(m.phonesAsked()).toEqual(['+9779801112233']);
    await typeKeys(m.phone(1), '{Backspace}4');
    expect(signals[0]?.aborted).toBe(true);
    await m.lookUp();
    await act(async () => {
      release(MATCHES);
      await Promise.resolve();
    });
    expect(m.phonesAsked()).toEqual(['+9779801112233', '+9779801112234']);
    expect(m.region()?.textContent).toBe('');
  } finally {
    await m.unmount();
  }
});

it('looks up the primary number in E.164 once it is complete, not while it is short', async () => {
  const fetcher = vi.fn<DuplicateFetcher>().mockResolvedValue(MATCHES);
  const m = await mountForPhones(fetcher);
  try {
    // A Nepal mobile typed into the Nepal row.
    await typeKeys(m.phone(1), '98123');
    await m.lookUp();
    expect(fetcher).not.toHaveBeenCalled();
    expect(m.region()?.textContent).toBe('');
    await typeKeys(m.phone(1), '45678');
    await m.lookUp();
    expect(m.phonesAsked()).toEqual(['+9779812345678']);
    expect(m.region()?.textContent).toContain('A similar lead or customer exists');
  } finally {
    await m.unmount();
  }

  // A US number: typing its +1 code switches the row to the United States.
  const us = vi.fn<DuplicateFetcher>().mockResolvedValue(MATCHES);
  const n = await mountForPhones(us);
  try {
    await typeKeys(n.phone(1), '+');
    await typeKeys(n.phone(1), '1 4155552671');
    await n.lookUp();
    expect(n.phonesAsked()).toEqual(['+14155552671']);
    expect(n.region()?.textContent).toContain('A similar lead or customer exists');
  } finally {
    await n.unmount();
  }
});

it('looks up the new primary when another number is marked primary', async () => {
  const fetcher = vi.fn<DuplicateFetcher>().mockResolvedValue([]);
  const m = await mountForPhones(fetcher);
  try {
    await typeKeys(m.phone(1), '9812345678');
    await click(m.container.querySelector('button[data-action="add"]'));
    await typeKeys(m.phone(2), '+');
    await typeKeys(m.phone(2), '1 4155552671');
    await m.lookUp();
    // The second number is not the primary one yet: only the first was looked up.
    expect(m.phonesAsked()).toEqual(['+9779812345678']);
    await click(m.container.querySelector('input[aria-label="Phone 2 primary"]'));
    await m.lookUp();
    expect(m.phonesAsked()).toEqual(['+9779812345678', '+14155552671']);
  } finally {
    await m.unmount();
  }
});

it('sends the typed company and email with the primary number in one lookup', async () => {
  const fetcher = vi.fn<DuplicateFetcher>().mockResolvedValue([]);
  const m = await mountForPhones(fetcher);
  try {
    await fill(m.container.querySelector('[name="companyName"]'), 'Himalayan');
    await m.lookUp();
    await fill(m.container.querySelector('[name="email"]'), 'buyer@himalayan.example');
    await m.lookUp();
    await typeKeys(m.phone(1), '9812345678');
    await m.lookUp();
    const last = fetcher.mock.calls.at(-1)![0];
    expect(Object.fromEntries(last)).toEqual({
      company: 'Himalayan',
      email: 'buyer@himalayan.example',
      phone: '+9779812345678',
    });
  } finally {
    await m.unmount();
  }
});

it('asks only for a phone of 7+ digits, and sends the E.164 as it is', () => {
  const blank = { company: '', name: '', email: '' };
  expect(duplicateQuery({ ...blank, phone: null })).toBeNull();
  expect(duplicateQuery({ ...blank, phone: '+977981' })).toBeNull();
  expect(duplicateQuery({ ...blank, phone: '+977981234' })?.get('phone')).toBe('+977981234');
  expect(duplicateQuery({ ...blank, phone: '+14155552671' })?.get('phone')).toBe('+14155552671');
});
