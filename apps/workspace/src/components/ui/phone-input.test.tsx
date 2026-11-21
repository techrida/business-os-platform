// @vitest-environment jsdom
import { PhoneSchema } from '@bos/contracts';
import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { click, fill, mountForm, paste, typeKeys } from '@/test/form-interactions';
import { Field } from './field';
import { PhoneInput } from './phone-input';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function mount(node: ReactNode) {
  mounted = await mountForm(<form>{node}</form>);
  const { container } = mounted;
  return {
    container,
    box: () => container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!,
    hidden: () => container.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
    status: () => container.querySelector('[role="status"]')!.textContent,
    count: () => container.querySelector('[id$="-count"]')?.textContent,
    prefix: () => container.querySelector('[id$="-prefix"]')?.textContent,
    switchCountry: () => click(container.querySelector('button[type="button"]')),
  };
}

async function blur(element: HTMLElement) {
  await act(() => Promise.resolve(element.blur()));
}

describe('PhoneInput, Nepal', () => {
  it('shows +977 as a fixed prefix outside the typed text', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    expect(phone.prefix()).toBe('+977');
    expect(phone.box().value).toBe('');
    expect(phone.box().getAttribute('aria-describedby')).toContain(
      phone.container.querySelector('[id$="-prefix"]')!.id,
    );
    expect(phone.box().getAttribute('inputmode')).toBe('numeric');
  });

  it('refuses letters before they go in', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    await typeKeys(phone.box(), '98');
    await typeKeys(phone.box(), 'x');
    expect(phone.box().value).toBe('98');
    expect(phone.status()).toBe('A phone number takes digits only.');
    await typeKeys(phone.box(), '+');
    expect(phone.box().value).toBe('98');
  });

  it('posts E.164 that the contract accepts', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    await typeKeys(phone.box(), '9812345678');
    expect(phone.hidden()).toBe('+9779812345678');
    expect(PhoneSchema.safeParse(phone.hidden()).success).toBe(true);
  });

  it('holds a mobile number to ten digits and counts them', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    expect(phone.count()).toBe('Mobile: 10 digits, starting with 9');
    await typeKeys(phone.box(), '98123');
    expect(phone.count()).toBe('5 of 10 (mobile)');
    await blur(phone.box());
    expect(phone.status()).toBe('A mobile number has 10 digits; this has 5.');
    await typeKeys(phone.box(), '45678');
    expect(phone.status()).toBe('');
    await typeKeys(phone.box(), '9');
    expect(phone.box().value).toBe('9812345678');
    expect(phone.status()).toBe('A mobile number has 10 digits.');
  });

  it('treats a number not starting with 9 as a landline of 7 to 9 digits', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    await typeKeys(phone.box(), '14123');
    expect(phone.count()).toBe('5 of 7 to 9 (landline)');
    await blur(phone.box());
    expect(phone.status()).toBe('A landline number has 7 to 9 digits; this has 5.');
    await typeKeys(phone.box(), '4567');
    expect(phone.status()).toBe('');
    expect(phone.hidden()).toBe('+977141234567');
    expect(PhoneSchema.safeParse(phone.hidden()).success).toBe(true);
    await typeKeys(phone.box(), '8');
    expect(phone.box().value).toBe('141234567');
    expect(phone.status()).toBe('A landline number has 7 to 9 digits.');
  });

  it('refuses a leading 0 because +977 is already there', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    await typeKeys(phone.box(), '0');
    expect(phone.box().value).toBe('');
    expect(phone.status()).toBe('Leave out the leading 0. +977 is already there.');
  });

  it('cleans a pasted number to the national digits', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" />);
    await paste(phone.box(), '+977 98-1234 5678');
    expect(phone.box().value).toBe('9812345678');
    expect(phone.hidden()).toBe('+9779812345678');
    await fill(phone.box(), '');
    await paste(phone.box(), '977-9812345678');
    expect(phone.box().value).toBe('9812345678');
    await fill(phone.box(), '');
    await paste(phone.box(), '01-4123456');
    expect(phone.box().value).toBe('14123456');
    await fill(phone.box(), '');
    await paste(phone.box(), '(98) 1234-5678');
    expect(phone.box().value).toBe('9812345678');
  });

  it('shows a stored +977 number without the prefix and posts it back unchanged', async () => {
    const phone = await mount(
      <PhoneInput aria-label="Phone" name="phone" defaultValue="+9779812345678" />,
    );
    expect(phone.box().value).toBe('9812345678');
    expect(phone.hidden()).toBe('+9779812345678');
    expect(phone.box().getAttribute('aria-invalid')).toBeNull();
  });

  it('posts nothing for an empty box, and is named by its Field label', async () => {
    const phone = await mount(
      <Field label="Phone">{(control) => <PhoneInput {...control} name="phone" />}</Field>,
    );
    expect(phone.hidden()).toBe('');
    expect(phone.container.querySelector('label')!.getAttribute('for')).toBe(phone.box().id);
  });
});

describe('PhoneInput, another country', () => {
  it('starts in the international box for a stored foreign number', async () => {
    const phone = await mount(
      <PhoneInput aria-label="Phone" name="phone" defaultValue="+919876543210" />,
    );
    expect(phone.prefix()).toBe('+');
    expect(phone.box().value).toBe('919876543210');
    expect(phone.hidden()).toBe('+919876543210');
    expect(PhoneSchema.safeParse(phone.hidden()).success).toBe(true);
  });

  it('switches country with the link, empties the box, and holds E.164 limits', async () => {
    const seen: string[] = [];
    const phone = await mount(
      <PhoneInput
        aria-label="Phone"
        name="phone"
        defaultValue="+9779812345678"
        onValueChange={(next) => seen.push(next)}
      />,
    );
    await phone.switchCountry();
    expect(seen).toEqual(['']);
    expect(phone.prefix()).toBe('+');
    expect(phone.box().value).toBe('');
    expect(phone.hidden()).toBe('');
    await typeKeys(phone.box(), '0');
    expect(phone.status()).toBe('A country code does not start with 0.');
    await typeKeys(phone.box(), '14155550123');
    expect(phone.hidden()).toBe('+14155550123');
    await typeKeys(phone.box(), 'q');
    expect(phone.box().value).toBe('14155550123');
    await typeKeys(phone.box(), '4567');
    expect(phone.box().value).toBe('141555501234567');
    await typeKeys(phone.box(), '8');
    expect(phone.box().value).toBe('141555501234567');
    expect(phone.status()).toBe('A phone number has at most 15 digits, country code included.');
    // And back to Nepal.
    await phone.switchCountry();
    expect(phone.prefix()).toBe('+977');
    expect(phone.box().value).toBe('');
  });

  it('flags too few digits on blur', async () => {
    const phone = await mount(<PhoneInput aria-label="Phone" name="phone" defaultValue="+91" />);
    await typeKeys(phone.box(), '98');
    await blur(phone.box());
    expect(phone.status()).toBe(
      'A phone number has at least 7 digits, country code included; this has 4.',
    );
  });

  it('works controlled: the switch clears the parent value', async () => {
    function Harness() {
      const [phone, setPhone] = useState('+9779812345678');
      return <PhoneInput aria-label="Phone" name="phone" value={phone} onValueChange={setPhone} />;
    }
    const phone = await mount(<Harness />);
    await phone.switchCountry();
    expect(phone.hidden()).toBe('');
    await typeKeys(phone.box(), '4915112345678');
    expect(phone.hidden()).toBe('+4915112345678');
  });
});
