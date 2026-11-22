// @vitest-environment jsdom
// The lead's expected value and probability use the shared number inputs: the value groups as it is
// typed and posts plain digits under its original field name; the probability is a whole percent.
import { PhoneSchema } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, typeKeys } from '@/test/form-interactions';

import { LeadForm } from './lead-form';
import type { FormAction } from './types';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountLead(action: FormAction) {
  mounted = await mountForm(
    <LeadForm
      action={action}
      sources={[{ label: 'Referral', value: 'referral' }]}
      owners={[]}
      enabledCurrencies={['NPR', 'USD']}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  return mounted.container;
}

function labelOf(container: HTMLElement, text: string): HTMLLabelElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === text,
  );
  if (!label) throw new Error(`No label ${text}`);
  return label;
}

const boxFor = (container: HTMLElement, text: string) =>
  document.getElementById(labelOf(container, text).htmlFor) as HTMLInputElement | null;

describe('lead form number fields', () => {
  it('groups the expected value in the box and posts it as plain digits', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    const value = boxFor(container, 'Expected value');
    await fill(value, '1250000');
    expect(value?.value).toBe('12,50,000');
    await fill(boxFor(container, 'Probability (%)'), '40');
    await click(container.querySelector('button[type="submit"]'));
    const data = action.mock.calls[0]![1];
    expect(data.get('expectedValue')).toBe('1250000');
    expect(data.get('probability')).toBe('40');
  });

  it('asks for the currency before the value, and takes a whole percent', async () => {
    const container = await mountLead(vi.fn<FormAction>());
    const currency = labelOf(container, 'Currency');
    const value = labelOf(container, 'Expected value');
    expect(currency.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const probability = boxFor(container, 'Probability (%)');
    expect(probability?.type).toBe('text');
    expect(probability?.getAttribute('role')).toBe('spinbutton');
    await fill(probability, '40.5');
    expect(probability?.value).toBe('');
  });
});

describe('lead form phone', () => {
  const submitButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]');

  it('is the phone box: +977 shown as a fixed prefix, digits only, E.164 on a hidden input', async () => {
    const container = await mountLead(vi.fn<FormAction>());
    const phone = boxFor(container, 'Phone')!;
    expect(phone.type).toBe('text');
    expect(phone.getAttribute('inputmode')).toBe('numeric');
    expect(phone.getAttribute('name')).toBeNull();
    expect(container.querySelector('[id$="-prefix"]')?.textContent).toBe('+977');
    expect(container.querySelector('input[name="phone"]')?.getAttribute('type')).toBe('hidden');
    await typeKeys(phone, '98a');
    expect(phone.value).toBe('98');
  });

  it('stops a phone typed but left short at submit, with the reason and focus on the box', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    const phone = boxFor(container, 'Phone')!;
    await typeKeys(phone, '981234567');
    await click(submitButton(container));
    expect(action).not.toHaveBeenCalled();
    expect(container.textContent).toContain('A mobile number has 10 digits; this has 9.');
    expect(document.activeElement).toBe(phone);
  });

  it('posts an empty phone when none was typed, not a bare +977', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await click(submitButton(container));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![1].get('phone')).toBe('');
  });

  it('posts a full number in the E.164 shape the API takes', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await typeKeys(boxFor(container, 'Phone'), '9812345678');
    await click(submitButton(container));
    const posted = action.mock.calls[0]![1].get('phone');
    expect(posted).toBe('+9779812345678');
    expect(PhoneSchema.safeParse(posted).success).toBe(true);
  });
});
