// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeadForm } from '@/components/p2/crm/lead-form';
import { parseLead } from '@/components/p2/crm/forms';
import type { FormAction } from '@/components/p2/crm/types';
import { choose, click, fill, mountForm } from '@/test/form-interactions';

const ME = '11111111-1111-4111-8111-111111111111';
const RAM = '22222222-2222-4222-8222-222222222222';
const SITA = '33333333-3333-4333-8333-333333333333';
const OWNERS = [
  { value: RAM, label: 'Ram Thapa' },
  { value: ME, label: 'Asha Gurung' },
  { value: SITA, label: 'Sita Rai' },
];
const ALL_CURRENCIES = ['NPR', 'INR', 'USD'];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it('submits the lead form from the page header with the action’s original field names', async () => {
  const idempotencyKey = '44444444-4444-4444-8444-444444444444';
  const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
  const mounted = await mountForm(
    <LeadForm
      action={action}
      sources={[{ label: 'Referral', value: 'referral' }]}
      owners={OWNERS}
      enabledCurrencies={ALL_CURRENCIES}
      defaultOwnerId={ME}
      idempotencyKey={idempotencyKey}
    />,
  );

  try {
    const { container } = mounted;
    await fill(container.querySelector('[name="title"]'), 'Dispatch automation');
    await choose(container, 'source', 'Referral');
    await fill(container.querySelector('[name="companyName"]'), 'Binford Ltd.');
    await fill(container.querySelector('[name="contactName"]'), 'Sunita Shrestha');
    // A lead needs a way to reach the person (an email or a phone) before it saves.
    await fill(container.querySelector('[name="email"]'), 'sunita@binford.example');
    const probabilityLabel = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith('Probability'),
    );
    await fill(document.getElementById(probabilityLabel?.htmlFor ?? ''), '40');

    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton?.closest('form')).toBeNull();
    await click(submitButton);

    expect(action).toHaveBeenCalledTimes(1);
    const data = action.mock.calls[0]![1];
    expect(data.get('idempotencyKey')).toBe(idempotencyKey);
    expect(parseLead(data)).toMatchObject({
      ok: true,
      data: { title: 'Dispatch automation', source: 'referral', probability: 40 },
    });
  } finally {
    await mounted.unmount();
  }
});

async function mountLead(
  owners: typeof OWNERS,
  defaultOwnerId: string | undefined,
  enabledCurrencies: readonly string[] = ALL_CURRENCIES,
) {
  const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
  const mounted = await mountForm(
    <LeadForm
      action={action}
      sources={[{ label: 'Referral', value: 'referral' }]}
      owners={owners}
      enabledCurrencies={enabledCurrencies}
      defaultOwnerId={defaultOwnerId}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  const { container } = mounted;
  await fill(container.querySelector('[name="title"]'), 'Dispatch automation');
  await choose(container, 'source', 'Referral');
  await fill(container.querySelector('[name="companyName"]'), 'Binford Ltd.');
  await fill(container.querySelector('[name="contactName"]'), 'Sunita Shrestha');
  await fill(container.querySelector('[name="email"]'), 'sunita@binford.example');
  async function send() {
    await click(container.querySelector('button[type="submit"]'));
    expect(action).toHaveBeenCalledTimes(1);
    return action.mock.calls[0]![1];
  }
  return { ...mounted, send };
}

it('starts the lead owner on the signed-in user, not the first person in the list', async () => {
  const mounted = await mountLead(OWNERS, ME);
  try {
    const data = await mounted.send();
    expect(data.get('ownerUserId')).toBe(ME);
    const parsed = parseLead(data);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.fieldErrors));
    expect(parsed.data.ownerUserId).toBe(ME);
    expect(parsed.data).not.toHaveProperty('followUp');
  } finally {
    await mounted.unmount();
  }
});

it('preselects nobody else when the signed-in user is not placed in the owner list', async () => {
  const mounted = await mountLead(OWNERS, undefined);
  try {
    const { container } = mounted;
    await fill(container.querySelector('[name="followUpAt"]'), '2026-12-01T10:30');
    const parsed = parseLead(await mounted.send());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.fieldErrors));
    expect(parsed.data).not.toHaveProperty('ownerUserId');
    expect(parsed.data.followUp).not.toHaveProperty('assigneeUserId');
  } finally {
    await mounted.unmount();
  }
});

// Finance, Accountant and PMO are not placed in the owner list: an ownerless lead goes to the default lead owner. The
// owner box names that real person (BOS-UI-001), and the hint says where the default comes from.
describe('the owner of a lead the caller may not own', () => {
  const PEOPLE = [
    { value: RAM, label: 'Ram Thapa', role: 'Head · Sales' },
    { value: SITA, label: 'Sita Rai', role: 'Sales' },
  ];
  const mountUnplaced = (
    defaultOwnerId: string | undefined,
    defaultOwnerSource: 'settings' | 'sales_head' | undefined,
    callerUnplaced = true,
  ) =>
    mountForm(
      <LeadForm
        action={vi.fn<FormAction>()}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={PEOPLE}
        enabledCurrencies={ALL_CURRENCIES}
        defaultOwnerId={defaultOwnerId}
        defaultOwnerSource={defaultOwnerSource}
        callerUnplaced={callerUnplaced}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
      />,
    );
  const ownerBox = (c: HTMLElement) =>
    c.querySelector<HTMLInputElement>('input[role="combobox"][aria-labelledby]')!;

  it('shows the Settings default owner by name and role, never "Default owner", with the source as a hint', async () => {
    const mounted = await mountUnplaced(RAM, 'settings');
    try {
      const { container } = mounted;
      const hidden = container.querySelector<HTMLInputElement>(
        'input[type="hidden"][name="ownerUserId"]',
      );
      // The box shows the person; the form posts nothing, so the API applies the default as before.
      expect(hidden?.value).toBe('');
      const box = hidden!.parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      expect(box.value).toBe('Ram Thapa Head · Sales');
      expect(container.textContent).toContain('Default owner from Settings.');
    } finally {
      await mounted.unmount();
    }
  });

  it('says the default is the Sales head when Settings names no one', async () => {
    const mounted = await mountUnplaced(RAM, 'sales_head');
    try {
      expect(mounted.container.textContent).toContain('Default owner: the Sales head.');
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing about a missing default when who the caller is did not load', async () => {
    const mounted = await mountUnplaced(undefined, undefined, false);
    try {
      expect(mounted.container.textContent).not.toContain('No default owner is set');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows a clear empty state, not a made-up name, when nobody can be the default', async () => {
    const mounted = await mountUnplaced(undefined, undefined);
    try {
      const hidden = mounted.container.querySelector<HTMLInputElement>(
        'input[type="hidden"][name="ownerUserId"]',
      );
      expect(hidden?.value).toBe('');
      const box = hidden!.parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      expect(box.value).toBe('');
      expect(mounted.container.textContent).toContain(
        'No default owner is set and you cannot own this lead, so choose who it goes to.',
      );
      expect(ownerBox(mounted.container)).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

it('shows a single owner by name and still posts it', async () => {
  const mounted = await mountLead([{ value: ME, label: 'Asha Gurung' }], ME);
  try {
    const owner = mounted.container.querySelector('input[type="hidden"][name="ownerUserId"]');
    expect(
      owner?.parentElement?.querySelector<HTMLInputElement>('input[role="combobox"]')?.value,
    ).toBe('Asha Gurung');
    expect(mounted.container.textContent).toContain('You can create leads for yourself only.');
    const data = await mounted.send();
    expect(data.getAll('ownerUserId')).toEqual([ME]);
  } finally {
    await mounted.unmount();
  }
});

it('posts no owner when the owner list did not load, so the API defaults to the caller', async () => {
  const mounted = await mountLead([], undefined);
  try {
    expect(mounted.container.textContent).toContain('The list of owners did not load');
    const data = await mounted.send();
    expect(data.has('ownerUserId')).toBe(false);
    expect(data.has('followUpAssigneeUserId')).toBe(false);
  } finally {
    await mounted.unmount();
  }
});

it('sends the scheduled follow-up with its type, Kathmandu time and the owner as assignee', async () => {
  const mounted = await mountLead(OWNERS, ME);
  try {
    const { container } = mounted;
    await choose(container, 'ownerUserId', 'Sita Rai');
    await click(container.querySelector('[role="radio"][data-kind="meeting"]'));
    await fill(container.querySelector('[name="followUpAt"]'), '2026-12-01T10:30');
    await fill(container.querySelector('[name="followUpSubject"]'), 'Walk through the proposal');

    const data = await mounted.send();
    const parsed = parseLead(data);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.fieldErrors));
    expect(parsed.data.ownerUserId).toBe(SITA);
    expect(parsed.data.followUp).toEqual({
      kind: 'meeting',
      dueAt: '2026-12-01T10:30:00+05:45',
      assigneeUserId: SITA,
      subject: 'Walk through the proposal',
    });
    expect(data.has('nextFollowUpAt')).toBe(false);
  } finally {
    await mounted.unmount();
  }
});

it('keeps a chosen assignee when the owner changes afterwards', async () => {
  const mounted = await mountLead(OWNERS, ME);
  try {
    const { container } = mounted;
    await choose(container, 'followUpAssigneeUserId', 'Ram Thapa');
    await choose(container, 'ownerUserId', 'Sita Rai');
    await fill(container.querySelector('[name="followUpAt"]'), '2026-12-01T10:30');

    const parsed = parseLead(await mounted.send());
    expect(parsed).toMatchObject({
      ok: true,
      data: { ownerUserId: SITA, followUp: { kind: 'call', assigneeUserId: RAM } },
    });
  } finally {
    await mounted.unmount();
  }
});

it('offers only the enabled currencies and posts the one chosen', async () => {
  const mounted = await mountLead(OWNERS, ME, ['NPR', 'USD']);
  try {
    const { container } = mounted;
    // The Company box (a combobox since BOS-UI-002) still has its list open after typing; a real click on the
    // currency trigger would blur it first.
    await act(() => {
      container
        .querySelector('input[name="companyName"]')
        ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return Promise.resolve();
    });
    const trigger = container
      .querySelector('input[type="hidden"][name="currency"]')
      ?.parentElement?.querySelector('button');
    await click(trigger ?? null);
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
      o.textContent?.trim(),
    );
    expect(labels).toEqual(['NPR (Nepalese rupee)', 'USD (US dollar)']);
    await click(trigger ?? null);

    await choose(container, 'currency', 'USD (US dollar)');
    const parsed = parseLead(await mounted.send());
    expect(parsed).toMatchObject({ ok: true, data: { currency: 'USD' } });
  } finally {
    await mounted.unmount();
  }
});
