// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fill, mountForm, typeKeys } from '@/test/form-interactions';
import { AddressFields, type AddressFieldsProps, type AddressValue } from './address-fields';

let mounted: Awaited<ReturnType<typeof mountForm>> | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout, so no scrollIntoView; the list calls it to keep the highlighted country in view.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

let latest: AddressValue | null = null;
function Harness(props: Omit<AddressFieldsProps, 'value' | 'onChange'> & { start?: AddressValue }) {
  const [value, setValue] = useState<AddressValue>(
    props.start ?? { line: '', city: '', country: 'NP' },
  );
  return (
    <AddressFields
      {...props}
      value={value}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  latest = null;
  mounted = await mountForm(
    <form>
      <Harness name="address" {...props} />
    </form>,
  );
  const { container } = mounted;
  const byLabel = (text: string) => {
    const label = Array.from(container.querySelectorAll('label')).find(
      (element) => element.textContent === text,
    );
    if (!label) throw new Error(`No label ${text}`);
    return document.getElementById(label.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
  };
  return {
    container,
    byLabel,
    posted: () => Object.fromEntries(new FormData(container.querySelector('form')!).entries()),
  };
}

describe('AddressFields', () => {
  it('labels Address and City optional unless required; Country never is', async () => {
    const optional = await mount();
    expect(optional.byLabel('Address').tagName).toBe('TEXTAREA');
    expect(optional.byLabel('City').tagName).toBe('INPUT');
    // The marker sits beside the label, never inside it (UIP-FORM-008), and Country has none.
    expect(optional.container.textContent?.match(/Optional/g)).toHaveLength(2);
    expect(optional.container.textContent).not.toContain('(optional)');
    expect(optional.byLabel('Country').getAttribute('role')).toBe('combobox');
    await mounted!.unmount();
    const required = await mount({ required: true });
    expect(required.byLabel('Address').hasAttribute('required')).toBe(true);
    expect(required.byLabel('City').hasAttribute('required')).toBe(true);
    expect(required.byLabel('Country').getAttribute('aria-required')).toBe('true');
  });

  it('reports each field through onChange and posts line, city and country', async () => {
    const address = await mount({ required: true });
    const line = address.byLabel('Address') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      line,
      'Ward 4, Jhamsikhel Road',
    );
    await act(() => Promise.resolve(line.dispatchEvent(new Event('input', { bubbles: true }))));
    await fill(address.byLabel('City'), 'Lalitpur');
    expect(latest).toEqual({ line: 'Ward 4, Jhamsikhel Road', city: 'Lalitpur', country: 'NP' });
    const country = address.byLabel('Country') as HTMLInputElement;
    await typeKeys(country, 'india');
    await act(() =>
      Promise.resolve(
        country.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      ),
    );
    expect(latest).toEqual({ line: 'Ward 4, Jhamsikhel Road', city: 'Lalitpur', country: 'IN' });
    expect(address.posted()).toEqual({
      'address.line': 'Ward 4, Jhamsikhel Road',
      'address.city': 'Lalitpur',
      'address.country': 'IN',
    });
  });

  it('shows each field error under its field and marks that field invalid', async () => {
    const address = await mount({
      required: true,
      errors: { city: 'Enter the city.', country: 'Choose a country.' },
    });
    const city = address.byLabel('City');
    expect(city.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(city.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Enter the city.',
    );
    const country = address.byLabel('Country');
    expect(country.getAttribute('aria-invalid')).toBe('true');
    expect(country.getAttribute('aria-describedby')).toContain('-error');
    expect(address.byLabel('Address').getAttribute('aria-invalid')).toBeNull();
  });

  it('takes custom labels and keeps a long address whole', async () => {
    const long = 'Flat 12B, Tower C, Some Very Long Apartment Complex Name, Off Ring Road '.repeat(
      3,
    );
    const address = await mount({
      required: true,
      labels: { line: 'Registered address' },
      start: { line: long, city: 'Kathmandu', country: 'NP' },
    });
    expect(address.byLabel('Registered address').value).toBe(long);
    expect(address.byLabel('Registered address').getAttribute('maxlength')).toBe('500');
  });
});
