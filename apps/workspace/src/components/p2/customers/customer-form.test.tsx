import type { Currency } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CustomerForm } from './customer-form';
import type { CustomerFormState } from './form-state';
import { EMPTY_CUSTOMER_VALUES, type CustomerValues } from './forms';

const noop = (prev: CustomerFormState) => Promise.resolve(prev);

function render(
  mode: 'create' | 'edit',
  enabled: readonly Currency[] = ['NPR', 'INR', 'USD'],
  initial: CustomerValues = EMPTY_CUSTOMER_VALUES,
): string {
  return renderToStaticMarkup(
    <CustomerForm
      action={noop}
      initial={initial}
      enabledCurrencies={enabled}
      mode={mode}
      idempotencyKey="7c9e6679-7425-40de-944b-e07fc1f90ae7"
      customerId="11111111-1111-4111-8111-111111111111"
      version={1}
      cancelHref="/customers"
      reloadHref="/customers/new"
    />,
  );
}

/** The whole `<input>` tag with this name, whatever order React wrote its attributes in. */
const inputTag = (html: string, name: string): string =>
  new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';

/** The currency codes the default-currency picker offers, in order. */
const currencyOptions = (html: string): string[] =>
  [...html.matchAll(/<option[^>]*value="(NPR|INR|USD)"/g)].map((m) => m[1] ?? '');

describe('customer form', () => {
  it('asks for the main contact on create, with a typed, required email', () => {
    const html = render('create');
    expect(html).toContain('Primary Contact');
    expect(inputTag(html, 'contactName')).toContain('required=""');
    expect(inputTag(html, 'contactEmail')).toContain('type="email"');
    expect(inputTag(html, 'contactEmail')).toContain('required=""');
    // The phone is a PhoneInput: +977 shown as a fixed prefix, a numeric keypad, E.164 posted by a hidden input.
    expect(inputTag(html, 'contactPhone')).toContain('type="hidden"');
    expect(inputTag(html, 'contactPhone')).not.toContain('required');
    expect(html).toContain('>+977<');
    expect(html).toContain('inputMode="numeric"');
  });

  it('does not ask for a contact when editing the customer', () => {
    const html = render('edit');
    expect(html).not.toContain('Primary Contact');
    expect(html).not.toContain('name="contactEmail"');
  });

  // Fails on the old form, which listed every currency in CURRENCIES whatever Settings said.
  it('offers only the enabled currencies on create', () => {
    const html = render('create', ['NPR', 'INR']);
    expect(currencyOptions(html)).toEqual(['NPR', 'INR']);
    expect(html).toContain('Used when a quotation does not say otherwise.');
  });

  it("keeps an organization's own switched-off currency on edit and says it is off", () => {
    const html = render('edit', ['NPR'], { ...EMPTY_CUSTOMER_VALUES, defaultCurrency: 'USD' });
    expect(currencyOptions(html)).toEqual(['NPR', 'USD']);
    expect(html).toMatch(/<option[^>]*value="USD"[^>]*selected/);
    expect(inputTag(html, 'defaultCurrency')).toContain('value="USD"');
    expect(html).toContain('USD (US dollar) is switched off in Settings.');
    // The kept choice is a disabled list item, but the closed picker still shows it as the value.
    expect(html).toMatch(
      /<button[^>]*aria-haspopup="listbox"[^>]*>(?:(?!<\/button>).)*USD \(US dollar\)/,
    );
    expect(html).not.toContain('Used when a quotation does not say otherwise.');
  });

  it('lists no switched-off currency on edit when the saved one is still enabled', () => {
    const html = render('edit', ['NPR', 'INR'], {
      ...EMPTY_CUSTOMER_VALUES,
      defaultCurrency: 'INR',
    });
    expect(currencyOptions(html)).toEqual(['NPR', 'INR']);
    expect(html).not.toContain('switched off in Settings');
  });

  it('numbers the card eyebrows in the order the cards appear, and leaves them out of the headings', () => {
    const create = render('create');
    expect(create).toContain('01 · The basics');
    expect(create).toContain('02 · The contact');
    expect(create).toContain('03 · The address');
    expect(create).toContain('04 · The terms');
    // Without the contact card the numbers close up instead of skipping 02.
    const edit = render('edit');
    expect(edit).toContain('01 · The basics');
    expect(edit).toContain('02 · The address');
    expect(edit).toContain('03 · The terms');
    expect(edit).not.toContain('The contact');
    expect(create).toContain('aria-hidden="true">01 · The basics');
  });
});
