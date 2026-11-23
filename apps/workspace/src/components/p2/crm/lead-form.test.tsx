// @vitest-environment jsdom
// The lead's expected value and probability use the shared number inputs: the value groups as it is
// typed and posts plain digits under its original field name; the probability is a whole percent.
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm, settle, typeKeys } from '@/test/form-interactions';
import { countryFlag, phoneCountryButton, pickPhoneCountry } from '@/test/phone-field';

import { EMAIL_OR_PHONE, parseLead } from './forms';
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
    await fill(boxFor(container, 'Email'), 'sunita@binford.com.np');
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

const submitButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[type="submit"]');
const numberBox = (container: HTMLElement, n: number) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`)!;
const countryBox = (container: HTMLElement, n: number) => phoneCountryButton(container, n)!;

/** A complete lead, apart from the email and the phones, so parseLead reads what the form posted. */
async function fillRequired(container: HTMLElement) {
  await fill(boxFor(container, 'Lead title'), 'Dispatch automation');
  await choose(container, 'source', 'Referral');
  await fill(boxFor(container, 'Company or organization'), 'Binford Ltd.');
  await fill(boxFor(container, 'Contact person'), 'Sunita Shrestha');
}

async function pickCountry(box: HTMLInputElement, search: string) {
  await act(() => Promise.resolve(box.focus()));
  await act(() => Promise.resolve(box.select()));
  await typeKeys(box, search);
  await act(() =>
    Promise.resolve(
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ),
  );
}

describe('lead form country and phones', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it('starts in Nepal, posts the country, and each phone row is named for screen readers', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    expect(boxFor(container, 'Country')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="address.country"]')?.value).toBe(
      'NP',
    );
    expect(countryBox(container, 1).textContent).toBe(countryFlag('NP'));
    expect(numberBox(container, 1).getAttribute('inputmode')).toBe('tel');
    expect(container.querySelector('input[name="phone"]')).toBeNull();
  });

  it("moves a blank phone row to the lead's new country, and keeps a row with digits typed", async () => {
    const container = await mountLead(vi.fn<FormAction>());
    await click(container.querySelector('button[data-action="add"]'));
    await typeKeys(numberBox(container, 2), '98123');
    await pickCountry(boxFor(container, 'Country')!, 'India');
    expect(container.querySelector<HTMLInputElement>('input[name="address.country"]')?.value).toBe(
      'IN',
    );
    expect(countryBox(container, 1).textContent).toBe(countryFlag('IN'));
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.country"]')?.value).toBe(
      'IN',
    );
    expect(countryBox(container, 2).textContent).toBe(countryFlag('NP'));
  });

  it('describes the phone list by its hint for screen readers', async () => {
    const container = await mountLead(vi.fn<FormAction>());
    const group = numberBox(container, 1).closest('[role="group"][aria-labelledby]')!;
    const label = document.getElementById(group.getAttribute('aria-labelledby')!);
    expect(label?.textContent?.trim()).toBe('Phone');
    const notes = (group.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    // Optional sits beside the label (UIP-FORM-008), not in a hint under the box.
    expect(notes).toContain('Optional');
    expect(notes.join(' ')).not.toContain('Optional.');
  });

  it('posts two phones in different countries, which parseLead turns into the contract list', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await fillRequired(container);
    await typeKeys(numberBox(container, 1), '9812345678');
    await click(container.querySelector('button[data-action="add"]'));
    await pickPhoneCountry(countryBox(container, 2), 'United States');
    await typeKeys(numberBox(container, 2), '4155552671');
    await click(submitButton(container));
    expect(action).toHaveBeenCalledTimes(1);
    const data = action.mock.calls[0]![1];
    expect(data.get('phones.0.number')).toBe('+9779812345678');
    expect(data.get('phones.0.country')).toBe('NP');
    expect(data.get('phones.1.number')).toBe('+14155552671');
    expect(data.get('phones.1.country')).toBe('US');
    const parsed = parseLead(data);
    expect(parsed.ok && parsed.data.country).toBe('NP');
    expect(parsed.ok && parsed.data.phones).toEqual([
      { country: 'NP', e164: '+9779812345678', isPrimary: true },
      { country: 'US', e164: '+14155552671', isPrimary: false },
    ]);
  });

  it('switches a Nepal row to the United States when +1 4155552671 is typed, and posts +14155552671', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await typeKeys(numberBox(container, 1), '+');
    await typeKeys(numberBox(container, 1), '1 4155552671');
    await click(submitButton(container));
    const data = action.mock.calls[0]![1];
    expect(data.get('phones.0.number')).toBe('+14155552671');
    expect(data.get('phones.0.country')).toBe('US');
  });

  it('asks for an email or a phone before it submits, and clears the ask once one is typed', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await fillRequired(container);
    await click(submitButton(container));
    expect(action).not.toHaveBeenCalled();
    expect(container.textContent).toContain(EMAIL_OR_PHONE);
    const email = boxFor(container, 'Email')!;
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(email);

    await typeKeys(numberBox(container, 1), '9812345678');
    expect(container.textContent).not.toContain(EMAIL_OR_PHONE);
    await click(submitButton(container));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('lets a half-filled form reach the server, which names every missing field at once', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await fill(boxFor(container, 'Lead title'), 'Half a lead');
    await click(submitButton(container));
    expect(action).toHaveBeenCalledTimes(1);
    const parsed = parseLead(action.mock.calls[0]![1]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.fieldErrors.source).toMatch(/where the lead came from/);
      expect(parsed.fieldErrors.email).toBe(EMAIL_OR_PHONE);
    }
  });

  it('stops a number listed twice before it submits, with the reason under the second row', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await fillRequired(container);
    await typeKeys(numberBox(container, 1), '9812345678');
    await click(container.querySelector('button[data-action="add"]'));
    await typeKeys(numberBox(container, 2), '9812345678');
    await click(submitButton(container));
    expect(action).not.toHaveBeenCalled();
    expect(container.textContent).toContain('This number is already listed.');
    expect(document.activeElement).toBe(numberBox(container, 2));
  });

  it('submits with an email and no phone, posting no number', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    await fillRequired(container);
    await fill(boxFor(container, 'Email'), 'sunita@binford.com.np');
    await click(submitButton(container));
    const data = action.mock.calls[0]![1];
    expect(data.get('phones.0.number')).toBe('');
    const parsed = parseLead(data);
    expect(parsed.ok && parsed.data.phones).toEqual([]);
  });

  it('stops a phone typed but left short at submit, with the reason and focus on the box', async () => {
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const container = await mountLead(action);
    const phone = numberBox(container, 1);
    await typeKeys(phone, '981234567');
    await click(submitButton(container));
    expect(action).not.toHaveBeenCalled();
    expect(container.textContent).toContain('A mobile number has 10 digits; this has 9.');
    expect(document.activeElement).toBe(phone);
  });

  it('tells the page the primary number as it becomes complete', async () => {
    const seen: (string | null)[] = [];
    mounted = await mountForm(
      <LeadForm
        action={vi.fn<FormAction>()}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={[]}
        enabledCurrencies={['NPR']}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
        onPrimaryPhoneChange={(e164) => seen.push(e164)}
      />,
    );
    expect(seen).toEqual([null]);
    await typeKeys(numberBox(mounted.container, 1), '9812345678');
    expect(seen).toEqual([null, '+9779812345678']);
  });

  it('starts an edit from the saved country and numbers', async () => {
    const seen: (string | null)[] = [];
    mounted = await mountForm(
      <LeadForm
        action={vi.fn<FormAction>()}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={[]}
        enabledCurrencies={['NPR']}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
        defaultCountry="US"
        defaultPhones={[
          { country: 'NP', e164: '+9779812345678', isPrimary: false },
          { country: 'US', e164: '+14155552671', isPrimary: true },
        ]}
        phonesKey={3}
        onPrimaryPhoneChange={(e164) => seen.push(e164)}
      />,
    );
    const { container } = mounted;
    expect(container.querySelector<HTMLInputElement>('input[name="address.country"]')?.value).toBe(
      'US',
    );
    expect(container.querySelector<HTMLInputElement>('input[name="phones.1.number"]')?.value).toBe(
      '+14155552671',
    );
    expect(seen).toEqual(['+14155552671']);
  });

  it('keeps the typed numbers when the server refuses the save', async () => {
    const action = vi
      .fn<FormAction>()
      .mockResolvedValue({ values: {}, fieldErrors: { title: 'Enter a title.' } });
    const container = await mountLead(action);
    await typeKeys(numberBox(container, 1), '9812345678');
    await click(submitButton(container));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Enter a title.');
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')?.value).toBe(
      '+9779812345678',
    );
    expect(numberBox(container, 1).value).toBe('+977 9812345678');
  });
});

describe('lead form, a phone typed before the page loaded', () => {
  it('keeps the number and lets the lead save with it and no email', async () => {
    Element.prototype.scrollIntoView = () => {};
    const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
    const node = (
      <LeadForm
        action={action}
        sources={[{ label: 'Referral', value: 'referral' }]}
        owners={[]}
        enabledCurrencies={['NPR']}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
      />
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(node);
    document.body.append(container);
    numberBox(container, 1).value = '9812345678';
    let root: Root | null = null;
    await act(() => {
      root = hydrateRoot(container, node, { onRecoverableError: () => {} });
      return Promise.resolve();
    });
    try {
      expect(
        container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')?.value,
      ).toBe('+9779812345678');
      await click(submitButton(container));
      expect(action).toHaveBeenCalledTimes(1);
      expect(action.mock.calls[0]![1].get('phones.0.number')).toBe('+9779812345678');
    } finally {
      await act(() => Promise.resolve(root!.unmount()));
      container.remove();
    }
  });
});

describe('lead form source', () => {
  it('leaves no event re-dispatch for the duplicate hint in the form', () => {
    expect(LeadForm.toString()).not.toContain('dispatchEvent');
  });
});
