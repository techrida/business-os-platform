// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

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

// Finance, Accountant and PMO are not placed in the owner list: an empty owner goes to the default lead owner,
// so the choice must not say "You". Only when who the caller is did not load does the API make it theirs.
it('labels the empty owner Default owner for a caller who is not placed, and You when unknown', async () => {
  /** What the owner select shows before anyone is chosen: the empty choice's label. */
  const emptyOwner = async (callerUnplaced: boolean | undefined) => {
    const mounted = await mountForm(
      <LeadForm
        action={vi.fn<FormAction>()}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={OWNERS}
        enabledCurrencies={ALL_CURRENCIES}
        defaultOwnerId={undefined}
        callerUnplaced={callerUnplaced}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
      />,
    );
    try {
      const field = mounted.container.querySelector('input[type="hidden"][name="ownerUserId"]');
      expect(field?.getAttribute('value')).toBe('');
      return field?.parentElement?.querySelector('button')?.textContent?.trim();
    } finally {
      await mounted.unmount();
    }
  };
  expect(await emptyOwner(true)).toBe('Default owner');
  expect(await emptyOwner(undefined)).toBe('You');
});

it('shows a single owner read-only and still posts it', async () => {
  const mounted = await mountLead([{ value: ME, label: 'Asha Gurung' }], ME);
  try {
    const owner = mounted.container.querySelector('input[type="hidden"][name="ownerUserId"]');
    expect(owner?.parentElement?.querySelector('button')?.hasAttribute('disabled')).toBe(true);
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
