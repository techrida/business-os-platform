// @vitest-environment jsdom
import type { CountryCode } from '@bos/contracts';
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm, typeKeys } from '@/test/form-interactions';
import { CountrySelect } from './country-select';
import { Field } from './field';

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

function Harness({
  start = 'NP',
  compact,
  onChange,
  onReselect,
}: {
  start?: CountryCode;
  compact?: boolean;
  onChange?: (code: CountryCode) => void;
  onReselect?: (code: CountryCode) => void;
}) {
  const [value, setValue] = useState<CountryCode>(start);
  return (
    <Field label="Country">
      {(control) => (
        <CountrySelect
          id={control.id}
          aria-labelledby={control['aria-labelledby']}
          name="country"
          compact={compact}
          value={value}
          onChange={(code) => {
            setValue(code);
            onChange?.(code);
          }}
          onReselect={onReselect}
        />
      )}
    </Field>
  );
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  mounted = await mountForm(
    <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
      <Harness {...props} />
    </form>,
  );
  const { container } = mounted;
  return {
    container,
    onSubmit,
    box: () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!,
    hidden: () => container.querySelector<HTMLInputElement>('input[name="country"]')!.value,
    chip: () => container.querySelector('[aria-hidden="true"]')!.textContent,
    options: () => Array.from(document.querySelectorAll('[role="option"]')),
  };
}

async function key(element: HTMLElement, name: string) {
  await act(() =>
    Promise.resolve(
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      ),
    ),
  );
}

describe('CountrySelect', () => {
  it('shows the flag, the ISO code as text and the name, and posts the code', async () => {
    const select = await mount();
    expect(select.box().value).toBe('Nepal');
    expect(select.chip()).toBe('\u{1F1F3}\u{1F1F5}NP');
    expect(select.hidden()).toBe('NP');
  });

  it('is named by its Field label and announces itself as a combobox', async () => {
    const select = await mount();
    const label = select.container.querySelector('label')!;
    expect(select.box().getAttribute('aria-labelledby')).toBe(label.id);
    expect(select.box().id).toBe(label.htmlFor);
    expect(select.box().getAttribute('aria-expanded')).toBe('false');
    expect(select.box().getAttribute('aria-autocomplete')).toBe('list');
  });

  it('opens on ArrowDown on the chosen country, Nepal first in the list', async () => {
    const select = await mount();
    await act(() => Promise.resolve(select.box().focus()));
    await key(select.box(), 'ArrowDown');
    expect(select.box().getAttribute('aria-expanded')).toBe('true');
    const active = select.box().getAttribute('aria-activedescendant')!;
    expect(document.getElementById(active)!.textContent).toContain('Nepal');
    expect(select.options()[0]!.textContent).toContain('NP +977');
    await key(select.box(), 'ArrowDown');
    await key(select.box(), 'Enter');
    expect(select.hidden()).not.toBe('NP');
  });

  it('finds a country by ISO code, by calling code and by name, best match first', async () => {
    const changes: CountryCode[] = [];
    const select = await mount({ onChange: (code) => changes.push(code) });
    await typeKeys(select.box(), 'us');
    await key(select.box(), 'Enter');
    expect(select.hidden()).toBe('US');
    expect(select.box().value).toBe('United States');
    await act(() => Promise.resolve(select.box().select()));
    await typeKeys(select.box(), '+44');
    await key(select.box(), 'Enter');
    expect(select.hidden()).toBe('GB');
    await act(() => Promise.resolve(select.box().select()));
    await typeKeys(select.box(), 'india');
    await key(select.box(), 'Enter');
    expect(changes).toEqual(['US', 'GB', 'IN']);
  });

  it('says so when nothing matches', async () => {
    const select = await mount();
    await typeKeys(select.box(), 'zzzq');
    expect(select.options()).toHaveLength(0);
    expect(document.body.textContent).toContain('No country matches.');
  });

  it('never submits the form on Enter, and Escape puts the chosen country back', async () => {
    const select = await mount();
    await typeKeys(select.box(), 'jap');
    await key(select.box(), 'Escape');
    expect(select.box().getAttribute('aria-expanded')).toBe('false');
    expect(select.box().value).toBe('Nepal');
    await key(select.box(), 'Enter');
    expect(select.onSubmit).not.toHaveBeenCalled();
    expect(select.hidden()).toBe('NP');
  });

  it('keeps a country when the text is cleared and left', async () => {
    const changes: CountryCode[] = [];
    const select = await mount({ start: 'IN', onChange: (code) => changes.push(code) });
    await typeKeys(select.box(), '{Backspace}');
    await act(() => Promise.resolve(select.box().blur()));
    expect(select.box().value).toBe('India');
    expect(select.hidden()).toBe('IN');
    expect(changes).toEqual([]);
  });

  it('tells onReselect, not onChange, when the chosen country is picked again', async () => {
    const changes: CountryCode[] = [];
    const reselected: CountryCode[] = [];
    const select = await mount({
      onChange: (code) => changes.push(code),
      onReselect: (code) => reselected.push(code),
    });
    await typeKeys(select.box(), 'nepal');
    await key(select.box(), 'Enter');
    expect(reselected).toEqual(['NP']);
    expect(changes).toEqual([]);
    expect(select.box().getAttribute('aria-expanded')).toBe('false');
    // The list opens on the chosen country, so ArrowDown then Enter is a re-pick too.
    await key(select.box(), 'ArrowDown');
    await key(select.box(), 'Enter');
    expect(reselected).toEqual(['NP', 'NP']);
    expect(changes).toEqual([]);
    // Another country goes to onChange only; Escape and leaving tell neither.
    await act(() => Promise.resolve(select.box().select()));
    await typeKeys(select.box(), 'india');
    await key(select.box(), 'Enter');
    expect(changes).toEqual(['IN']);
    expect(reselected).toEqual(['NP', 'NP']);
    await typeKeys(select.box(), 'jap');
    await key(select.box(), 'Escape');
    await act(() => Promise.resolve(select.box().blur()));
    expect(changes).toEqual(['IN']);
    expect(reselected).toEqual(['NP', 'NP']);
  });

  it('shows the calling code in the compact phone form and lists only countries with phones', async () => {
    const select = await mount({ start: 'US', compact: true });
    expect(select.box().value).toBe('+1');
    expect(select.chip()).toContain('US');
    const describedBy = select.box().getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe('United States');
    await typeKeys(select.box(), 'antarc');
    expect(select.options()).toHaveLength(0);
  });
});
