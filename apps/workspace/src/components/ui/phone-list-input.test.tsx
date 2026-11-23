// @vitest-environment jsdom
import { PartyPhonesSchema, type CountryCode, type PartyPhoneInput } from '@bos/contracts';
import { act, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { click, mountForm, paste, typeKeys } from '@/test/form-interactions';
import { PhoneListInput, type PhoneListInputProps, type PhoneRowProblem } from './phone-list-input';

let mounted: Awaited<ReturnType<typeof mountForm>> | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

async function mount(props: PhoneListInputProps = {}) {
  const seen = {
    phones: [] as PartyPhoneInput[][],
    problems: [] as PhoneRowProblem[][],
    primary: [] as (string | null)[],
  };
  mounted = await mountForm(
    <form>
      <PhoneListInput
        name="phones"
        onChange={(phones) => seen.phones.push(phones)}
        onValidityChange={(problems) => seen.problems.push(problems)}
        onPrimaryChange={(e164) => seen.primary.push(e164)}
        {...props}
      />
    </form>,
  );
  const { container } = mounted;
  const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);
  return {
    container,
    seen,
    number: (n: number) => q<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`)!,
    country: (n: number) => q<HTMLInputElement>(`input[aria-label="Phone ${n} country"]`)!,
    primary: (n: number) => q<HTMLButtonElement>(`button[aria-label="Phone ${n} primary"]`)!,
    button: (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`),
    add: () => q<HTMLButtonElement>('button[data-action="add"]')!,
    rows: () => container.querySelectorAll('li[data-row]').length,
    posted: (field: string) => q<HTMLInputElement>(`input[name="phones.${field}"]`)?.value,
    last: () => seen.phones.at(-1),
  };
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

describe('PhoneListInput, country from a typed code', () => {
  it('switches a Nepal row to the United States when +1 is typed, and posts +14155552671', async () => {
    const list = await mount();
    expect(list.country(1).value).toBe('+977');
    await typeKeys(list.number(1), '+');
    expect(document.activeElement).toBe(list.number(1));
    await typeKeys(list.number(1), '1 4155552671');
    expect(list.posted('0.country')).toBe('US');
    expect(list.country(1).value).toBe('+1');
    expect(list.posted('0.number')).toBe('+14155552671');
    expect(list.last()).toEqual([
      { country: 'US', e164: '+14155552671', label: null, isPrimary: true },
    ]);
    expect(PartyPhonesSchema.safeParse(list.last()).success).toBe(true);
  });

  it('switches to Nepal when +977 is typed', async () => {
    const list = await mount({ defaultCountry: 'IN' });
    await typeKeys(list.number(1), '+');
    await typeKeys(list.number(1), '9779812345678');
    expect(list.posted('0.country')).toBe('NP');
    expect(list.last()).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
    ]);
  });

  it('opens a pasted international number in its own country box', async () => {
    const list = await mount();
    await paste(list.number(1), '+1 (415) 555-2671');
    expect(list.posted('0.country')).toBe('US');
    expect(list.number(1).value).toBe('4155552671');
    expect(list.posted('0.number')).toBe('+14155552671');
    expect(document.activeElement).toBe(list.number(1));
  });

  it('leaves the full-number box when the same country is picked again', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '+');
    await pickCountry(list.country(1), 'nepal');
    // Back in Nepal's own box: the digits are the national number, not a calling code.
    await typeKeys(list.number(1), '9812345678');
    expect(list.posted('0.country')).toBe('NP');
    expect(list.posted('0.number')).toBe('+9779812345678');
  });

  it('keeps the typed number when the same country is picked again from the full-number box', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '+');
    await typeKeys(list.number(1), '9779812345678');
    expect(list.posted('0.country')).toBe('NP');
    await pickCountry(list.country(1), 'nepal');
    expect(list.number(1).value).toBe('9812345678');
    expect(list.posted('0.number')).toBe('+9779812345678');
    expect(list.last()).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
    ]);
  });

  it('holds no value when only the calling code was typed and the same country is picked again', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '+');
    await typeKeys(list.number(1), '977');
    await pickCountry(list.country(1), 'nepal');
    expect(list.number(1).value).toBe('');
    expect(list.posted('0.number')).toBe('');
  });
});

describe('PhoneListInput, rows', () => {
  it('keeps FX8 Nepal rules in a Nepal row', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '0');
    expect(list.number(1).value).toBe('');
    await typeKeys(list.number(1), '98123456789');
    expect(list.number(1).value).toBe('9812345678');
    expect(list.posted('0.number')).toBe('+9779812345678');
  });

  it('checks another country with libphonenumber and reports the row until it is valid', async () => {
    const list = await mount();
    await pickCountry(list.country(1), 'united kingdom');
    expect(list.posted('0.country')).toBe('GB');
    await typeKeys(list.number(1), '07911');
    expect(list.seen.problems.at(-1)).toHaveLength(1);
    expect(list.seen.problems.at(-1)?.[0]?.index).toBe(0);
    expect(list.seen.problems.at(-1)?.[0]?.message).toContain('United Kingdom');
    expect(list.seen.phones).toEqual([]);
    await act(() => Promise.resolve(list.number(1).blur()));
    expect(list.number(1).getAttribute('aria-invalid')).toBe('true');
    await typeKeys(list.number(1), '123456');
    // `07911123456` is a UK mobile written with its trunk 0, which E.164 leaves out.
    expect(list.seen.phones).toEqual([]);
    await act(() => Promise.resolve(list.number(1).blur()));
    expect(list.container.textContent).toContain('Leave out the leading 0. +44 is already there.');
    expect(list.seen.problems.at(-1)).toEqual([
      expect.objectContaining({ message: 'Leave out the leading 0. +44 is already there.' }),
    ]);
    list.number(1).setSelectionRange(0, 11);
    await typeKeys(list.number(1), '{Backspace}');
    await typeKeys(list.number(1), '7911123456');
    expect(list.posted('0.number')).toBe('+447911123456');
    expect(list.seen.problems.at(-1)).toEqual([]);
    expect(list.last()).toEqual([
      { country: 'GB', e164: '+447911123456', label: null, isPrimary: true },
    ]);
  });

  it('carries the digits over when the country is changed', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '98123');
    await pickCountry(list.country(1), 'india');
    expect(list.number(1).value).toBe('98123');
    expect(list.posted('0.number')).toBe('+9198123');
  });

  it('round-trips two numbers in different countries', async () => {
    const given: PartyPhoneInput[] = [
      { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: false },
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
    ];
    const list = await mount({ defaultValue: given });
    expect(list.number(1).value).toBe('9812345678');
    expect(list.number(2).value).toBe('4155552671');
    const posted = [0, 1].map((i) => ({
      country: list.posted(`${i}.country`),
      e164: list.posted(`${i}.number`),
      label: list.posted(`${i}.label`),
      isPrimary: list.posted(`${i}.isPrimary`) === 'true',
    }));
    expect(posted).toEqual(given);
    await mounted!.unmount();

    // Typed fresh: a Nepal number, then a US one in a second row.
    const typed = await mount();
    await typeKeys(typed.number(1), '9812345678');
    await click(typed.add());
    expect(document.activeElement).toBe(typed.number(2));
    await pickCountry(typed.country(2), '+1');
    await typeKeys(typed.number(2), '4155552671');
    const out = typed.last()!;
    expect(out).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
      { country: 'US', e164: '+14155552671', label: null, isPrimary: false },
    ]);
    expect(PartyPhonesSchema.safeParse(out).success).toBe(true);
    await mounted!.unmount();
    const again = await mount({ defaultValue: out });
    expect(again.posted('0.number')).toBe('+9779812345678');
    expect(again.posted('1.number')).toBe('+14155552671');
    expect(again.posted('1.country')).toBe('US');
  });

  it('moves a row up and down and keeps focus on the moved row', async () => {
    const list = await mount({
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: false },
      ],
    });
    expect(list.button('Move phone 1 up')!.disabled).toBe(true);
    await click(list.button('Move phone 1 down'));
    expect(list.posted('0.number')).toBe('+14155552671');
    expect(list.posted('1.number')).toBe('+9779812345678');
    // The moved row is now last, so its down button is disabled and focus lands on its up button.
    expect(document.activeElement).toBe(list.button('Move phone 2 up'));
    expect(list.last()!.map((phone) => phone.e164)).toEqual(['+14155552671', '+9779812345678']);
  });

  it('marks exactly one primary', async () => {
    const list = await mount({
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: false },
      ],
    });
    expect(list.primary(1).getAttribute('aria-checked')).toBe('true');
    await click(list.primary(2));
    expect(list.primary(1).getAttribute('aria-checked')).toBe('false');
    expect(list.primary(2).getAttribute('aria-checked')).toBe('true');
    expect(list.posted('1.isPrimary')).toBe('true');
    expect(list.last()!.filter((phone) => phone.isPrimary)).toEqual([
      expect.objectContaining({ e164: '+14155552671' }),
    ]);
    expect(list.seen.primary.at(-1)).toBe('+14155552671');
  });

  it('promotes the first row when the primary is removed, and moves focus to a remaining row', async () => {
    const list = await mount({
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: false },
        { country: 'US', e164: '+14155552671', isPrimary: true },
      ],
    });
    await click(list.button('Remove phone 2'));
    expect(list.rows()).toBe(1);
    expect(list.primary(1).getAttribute('aria-checked')).toBe('true');
    expect(list.last()).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
    ]);
    expect(document.activeElement).toBe(list.number(1));
    // The last row is cleared, not removed: a fresh blank row in the default country.
    await click(list.button('Remove phone 1'));
    expect(list.rows()).toBe(1);
    expect(list.number(1).value).toBe('');
    expect(list.last()).toEqual([]);
    expect(list.button('Remove phone 1')).toBeNull();
  });

  it('holds at most five numbers', async () => {
    const list = await mount();
    for (let i = 0; i < 4; i += 1) await click(list.add());
    expect(list.rows()).toBe(5);
    expect(list.add().disabled).toBe(true);
    expect(list.container.textContent).toContain('Up to 5 numbers.');
    await click(list.add());
    expect(list.rows()).toBe(5);
  });

  it('gives every new row a fresh key, so a removed draft never comes back', async () => {
    const list = await mount();
    await click(list.add());
    await typeKeys(list.number(2), '98123');
    await click(list.button('Remove phone 2'));
    await click(list.add());
    expect(list.number(2).value).toBe('');
  });

  it('reports a number listed twice and sends it once', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '9812345678');
    await click(list.add());
    await typeKeys(list.number(2), '9812345678');
    expect(list.seen.problems.at(-1)).toEqual([
      expect.objectContaining({ index: 1, message: 'This number is already listed.' }),
    ]);
    expect(list.last()).toHaveLength(1);
    expect(list.container.textContent).toContain('This number is already listed.');
  });

  it('shows a server error under its row', async () => {
    const list = await mount({
      rowErrors: [undefined, 'Already used by another contact.'],
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'NP', e164: '+9779812345679', isPrimary: false },
      ],
    });
    const box = list.number(2);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toContain('-error');
    expect(list.container.textContent).toContain('Already used by another contact.');
  });
});

describe('PhoneListInput, text typed before hydration', () => {
  it('keeps a number typed before the page loaded and reports it', async () => {
    const seen: { phones: PartyPhoneInput[][]; primary: (string | null)[] } = {
      phones: [],
      primary: [],
    };
    const node = (
      <form>
        <PhoneListInput
          name="phones"
          onChange={(phones) => seen.phones.push(phones)}
          onPrimaryChange={(e164) => seen.primary.push(e164)}
        />
      </form>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(node);
    document.body.append(container);
    const box = container.querySelector<HTMLInputElement>('input[aria-label="Phone 1 number"]')!;
    box.value = '9812345678';
    let root: Root | null = null;
    await act(() => {
      root = hydrateRoot(container, node, { onRecoverableError: () => {} });
      return Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')!.value).toBe(
      '+9779812345678',
    );
    expect(seen.phones.at(-1)).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
    ]);
    expect(seen.primary).toEqual(['+9779812345678']);
    await act(() => Promise.resolve(root!.unmount()));
  });

  it('offers the phone keypad, which has a + key', async () => {
    const list = await mount();
    expect(list.number(1).getAttribute('inputmode')).toBe('tel');
  });
});

describe('PhoneListInput, primary number for the duplicate lookup', () => {
  it('reports the primary number as E.164 once it is complete, and null when it stops being', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '98123');
    expect(list.seen.primary).toEqual([]);
    await typeKeys(list.number(1), '45678');
    expect(list.seen.primary).toEqual(['+9779812345678']);
    await typeKeys(list.number(1), '{Backspace}');
    expect(list.seen.primary).toEqual(['+9779812345678', null]);
  });
});

describe('PhoneListInput showPrimary and maxRows', () => {
  it('hides the Primary control and stops adding at maxRows', async () => {
    const list = await mount({ showPrimary: false, maxRows: 2 });
    expect(list.container.querySelector('input[aria-label="Phone 1 primary"]')).toBeNull();
    await click(list.add());
    expect(list.rows()).toBe(2);
    expect(list.add().disabled).toBe(true);
    expect(list.container.textContent).toContain('Up to 2 numbers.');
    expect(list.posted('0.isPrimary')).toBe('true');
  });
});

describe('PhoneListInput duplicate rows block the submit', () => {
  it('stops the form submit while a number is listed twice, and lets it go once it is not', async () => {
    const list = await mount();
    await typeKeys(list.number(1), '9812345678');
    await click(list.add());
    await typeKeys(list.number(2), '9812345678');
    let submitted = 0;
    list.container.querySelector('form')!.addEventListener('submit', (event) => {
      if (!event.defaultPrevented) submitted += 1;
      event.preventDefault();
    });
    await act(() => Promise.resolve(list.container.querySelector('form')!.requestSubmit()));
    expect(submitted).toBe(0);
    expect(document.activeElement).toBe(list.number(2));
    await click(list.button('Remove phone 2'));
    await act(() => Promise.resolve(list.container.querySelector('form')!.requestSubmit()));
    expect(submitted).toBe(1);
  });
});

/** A party form whose country the test can change, the way the lead and customer forms change it. */
function PartyCountryForm({ start }: { start: CountryCode }) {
  const [country, setCountry] = useState<CountryCode>(start);
  return (
    <form>
      {(['NP', 'US', 'IN'] as const).map((code) => (
        <button key={code} type="button" data-party={code} onClick={() => setCountry(code)} />
      ))}
      <PhoneListInput name="phones" defaultCountry={country} />
    </form>
  );
}

async function mountParty(start: CountryCode = 'NP') {
  mounted = await mountForm(<PartyCountryForm start={start} />);
  const { container } = mounted;
  return {
    container,
    party: (code: CountryCode) => click(container.querySelector(`button[data-party="${code}"]`)),
    number: (n: number) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`)!,
    country: (n: number) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} country"]`)!,
    posted: (field: string) =>
      container.querySelector<HTMLInputElement>(`input[name="phones.${field}"]`)?.value,
    add: () => click(container.querySelector('button[data-action="add"]')),
  };
}

describe('PhoneListInput follows a changed party country', () => {
  it('moves an untouched blank row to the new country', async () => {
    const list = await mountParty('NP');
    await list.add();
    await list.party('US');
    expect(list.country(1).value).toBe('+1');
    expect(list.country(2).value).toBe('+1');
    expect(list.posted('0.country')).toBe('US');
    expect(list.posted('1.country')).toBe('US');
  });

  it('keeps a row the user typed in, or whose country the user picked', async () => {
    const list = await mountParty('NP');
    await typeKeys(list.number(1), '98123');
    await list.add();
    await pickCountry(list.country(2), 'india');
    expect(list.posted('1.country')).toBe('IN');
    await list.add();
    await list.party('US');
    expect(list.posted('0.country')).toBe('NP');
    expect(list.posted('0.number')).toBe('+97798123');
    expect(list.posted('1.country')).toBe('IN');
    expect(list.posted('2.country')).toBe('US');
  });
});

describe('PhoneListInput for screen readers', () => {
  it('describes the group by the caller hint and the list error', async () => {
    const list = await mount({
      'aria-labelledby': 'phones-label',
      'aria-describedby': 'phones-hint',
      error: 'Mark one number as primary.',
    });
    const group = list.container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('phones-label');
    const described = group.getAttribute('aria-describedby')!.split(' ');
    expect(described).toContain('phones-hint');
    const errorId = described.find((id) => id !== 'phones-hint')!;
    expect(document.getElementById(errorId)?.textContent).toBe('Mark one number as primary.');
  });

  it('announces a moved row politely', async () => {
    const list = await mount({
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: false },
      ],
    });
    const live = list.container.querySelector('[aria-live="polite"]')!;
    expect(live).not.toBeNull();
    expect(live.textContent).toBe('');
    await click(list.button('Move phone 2 up'));
    expect(live.textContent).toBe('Phone 2 moved to position 1.');
    await click(list.button('Move phone 1 down'));
    expect(live.textContent).toBe('Phone 1 moved to position 2.');
  });

  it('announces an identical move again', async () => {
    const list = await mount({
      defaultValue: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: false },
      ],
    });
    const live = list.container.querySelector('[aria-live="polite"]')!;
    await click(list.button('Move phone 2 up'));
    const first = live.textContent;
    await click(list.button('Move phone 2 up'));
    expect(live.textContent).not.toBe(first);
    expect(live.textContent?.replace(/\u00a0/g, '')).toBe(first);
  });
});

describe('PhoneListInput server errors follow their row', () => {
  const two: PartyPhoneInput[] = [
    { country: 'NP', e164: '+9779812345678', isPrimary: true },
    { country: 'NP', e164: '+9779812345679', isPrimary: false },
  ];

  it('keeps the error on its number after a move', async () => {
    const list = await mount({
      rowErrors: [undefined, 'Already used by another contact.'],
      defaultValue: two,
    });
    await click(list.button('Move phone 2 up'));
    expect(list.posted('0.number')).toBe('+9779812345679');
    expect(list.number(1).getAttribute('aria-invalid')).toBe('true');
    expect(list.number(2).getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps the error on its number after the row above is removed', async () => {
    const list = await mount({
      rowErrors: [undefined, 'Already used by another contact.'],
      defaultValue: two,
    });
    await click(list.button('Remove phone 1'));
    expect(list.posted('0.number')).toBe('+9779812345679');
    expect(list.number(1).getAttribute('aria-invalid')).toBe('true');
    expect(list.container.textContent).toContain('Already used by another contact.');
  });
});
