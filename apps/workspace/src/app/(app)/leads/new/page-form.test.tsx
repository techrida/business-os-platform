// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

import { LeadForm } from '@/components/p2/crm/lead-form';
import { parseLead } from '@/components/p2/crm/forms';
import type { FormAction } from '@/components/p2/crm/types';
import { choose, click, fill, mountForm } from '@/test/form-interactions';

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
      idempotencyKey={idempotencyKey}
    />,
  );

  try {
    const { container } = mounted;
    await fill(container.querySelector('[name="title"]'), 'Dispatch automation');
    await choose(container, 'source', 'Referral');
    await fill(container.querySelector('[name="companyName"]'), 'Binford Ltd.');
    await fill(container.querySelector('[name="contactName"]'), 'Sunita Shrestha');
    await fill(container.querySelector('[name="probability"]'), '40');

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
