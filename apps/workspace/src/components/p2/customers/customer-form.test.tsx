import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CustomerForm } from './customer-form';
import type { CustomerFormState } from './form-state';
import { EMPTY_CUSTOMER_VALUES } from './forms';

const noop = (prev: CustomerFormState) => Promise.resolve(prev);

function render(mode: 'create' | 'edit'): string {
  return renderToStaticMarkup(
    <CustomerForm
      action={noop}
      initial={EMPTY_CUSTOMER_VALUES}
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

describe('customer form', () => {
  it('asks for the main contact on create, with a typed, required email', () => {
    const html = render('create');
    expect(html).toContain('Primary Contact');
    expect(inputTag(html, 'contactName')).toContain('required=""');
    expect(inputTag(html, 'contactEmail')).toContain('type="email"');
    expect(inputTag(html, 'contactEmail')).toContain('required=""');
    expect(inputTag(html, 'contactPhone')).toContain('type="tel"');
    expect(inputTag(html, 'contactPhone')).not.toContain('required');
  });

  it('does not ask for a contact when editing the customer', () => {
    const html = render('edit');
    expect(html).not.toContain('Primary Contact');
    expect(html).not.toContain('name="contactEmail"');
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
