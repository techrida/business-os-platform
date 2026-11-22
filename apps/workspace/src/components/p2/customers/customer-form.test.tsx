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
    // The phones are a PhoneListInput: each row has its own country, +977 shown as a fixed prefix
    // for Nepal, and E.164 posted by a hidden input per row.
    expect(inputTag(html, 'contactPhones\\.0\\.number')).toContain('type="hidden"');
    expect(inputTag(html, 'contactPhones\\.0\\.country')).toContain('value="NP"');
    expect(html).toContain('aria-label="Phone 1 number"');
    expect(html).toContain('aria-label="Phone 1 country"');
    expect(html).toContain('>+977<');
    expect(html).not.toContain('name="contactPhone"');
    // The contact's own country starts from the address country.
    expect(inputTag(html, 'contactCountry')).toContain('value="NP"');
  });

  it("names the address country and the contact's country apart", () => {
    const html = render('create');
    const labels = [...html.matchAll(/<label[^>]*>([^<]*)<\/label>/g)].map((m) => m[1]);
    expect(labels.filter((text) => text === 'Country')).toHaveLength(1);
    expect(labels.filter((text) => text === 'Contact country')).toHaveLength(1);
  });

  it('does not ask for a contact when editing the customer', () => {
    const html = render('edit');
    expect(html).not.toContain('Primary Contact');
    expect(html).not.toContain('name="contactEmail"');
    expect(html).not.toContain('name="contactCountry"');
    expect(html).not.toContain('name="contactPhones.');
  });

  // FX9: one Address box, City and a Country picker replace the old five address fields.
  it('asks for the address as Address, City and Country, and posts them under address.', () => {
    const html = render('edit', ['NPR'], {
      ...EMPTY_CUSTOMER_VALUES,
      line: '500 Howard Street',
      city: 'San Francisco',
      country: 'US',
    });
    expect(html).toMatch(
      /<textarea[^>]*name="address\.line"[^>]*required=""[^>]*>500 Howard Street/,
    );
    expect(inputTag(html, 'address\\.city')).toContain('value="San Francisco"');
    expect(inputTag(html, 'address\\.country')).toContain('value="US"');
    expect(html).toContain('role="combobox"');
    for (const old of ['line1', 'line2', 'district', 'province', 'postalCode', 'country']) {
      expect(html).not.toContain(`name="${old}"`);
    }
    expect(html).not.toContain('Country code');
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

  // The card headings speak for themselves: no "01 · The basics" kicker above them.
  it('puts no numbered kicker above the card headings', () => {
    for (const html of [render('create'), render('edit')]) {
      expect(html).toContain('Basic Company Information');
      expect(html).toContain('Business Address');
      expect(html).not.toMatch(/0\d · The /);
    }
  });
});
