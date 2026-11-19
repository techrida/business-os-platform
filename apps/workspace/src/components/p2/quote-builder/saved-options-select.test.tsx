// @vitest-environment jsdom
import type { TermPreset } from '@bos/contracts';
import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, mountForm } from '@/test/form-interactions';

import { SavedOptionsSelect } from './saved-options-select';

const make = (n: number, kind: TermPreset['kind'], name: string, body: string): TermPreset => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind,
  name,
  body,
});
const standard = make(1, 'scope', 'Standard build', 'We build it.');
const support = make(2, 'scope', 'Annual support', 'We support it for a year.');
const presets = [standard, support, make(3, 'exclusions', 'Hardware', 'No hardware.')];

// A stand-in for the builder's Scope field: the same value/onFill wiring, plain textarea.
function Host({
  list = presets,
  initial = '',
}: {
  list?: readonly TermPreset[];
  initial?: string;
}) {
  const [text, setText] = useState(initial);
  return (
    <div>
      <SavedOptionsSelect
        kind="scope"
        presets={list}
        value={text}
        maxLength={10_000}
        onFill={setText}
      />
      <textarea aria-label="Scope text" value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}

const NAME = 'saved-scope';
const pick = (preset: TermPreset) => choose(document.body, NAME, preset.name);
const chosenValue = () =>
  document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${NAME}"]`)?.value;
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

async function type(value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    textarea(),
    value,
  );
  await act(() => {
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    return Promise.resolve();
  });
}
const settle = () => act(async () => {});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Dialog watches its body for overflow; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SavedOptionsSelect', () => {
  it('lists this kind by name under "Saved options" and nothing from other kinds', async () => {
    const view = await mountForm(<Host />);
    const trigger = document
      .querySelector(`input[type="hidden"][name="${NAME}"]`)
      ?.parentElement?.querySelector('button');
    await click(trigger ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Saved options', 'Annual support', 'Standard build']);
    await view.unmount();
  });

  it('fills an empty field and leaves it editable', async () => {
    const view = await mountForm(<Host />);
    await pick(standard);
    expect(textarea().value).toBe('We build it.');
    expect(chosenValue()).toBe('');
    expect(document.body.textContent).not.toContain('Replace the text you typed?');

    await type('We build it. Plus training.');
    expect(textarea().value).toBe('We build it. Plus training.');
    await view.unmount();
  });

  it('fills another option without asking while the field still holds the last fill', async () => {
    const view = await mountForm(<Host />);
    await pick(standard);
    await pick(support);
    expect(textarea().value).toBe(support.body);
    expect(document.body.textContent).not.toContain('Replace the text you typed?');
    await view.unmount();
  });

  it('asks before replacing edited text; Keep my text leaves it, Replace text swaps it', async () => {
    const view = await mountForm(<Host />);
    await pick(standard);
    await type('We build it, but only the first phase.');

    await pick(support);
    await settle();
    expect(document.body.textContent).toContain('Replace the text you typed?');
    expect(textarea().value).toBe('We build it, but only the first phase.');

    await click(button('Keep my text'));
    await settle();
    expect(document.body.textContent).not.toContain('Replace the text you typed?');
    expect(textarea().value).toBe('We build it, but only the first phase.');
    expect(chosenValue()).toBe('');

    await pick(support);
    await settle();
    await click(button('Replace text'));
    await settle();
    expect(textarea().value).toBe(support.body);
    expect(document.body.textContent).not.toContain('Replace the text you typed?');
    await view.unmount();
  });

  it('asks before replacing text that arrived with a saved draft', async () => {
    const view = await mountForm(<Host initial="Drafted earlier" />);
    await pick(standard);
    await settle();
    expect(document.body.textContent).toContain('Replace the text you typed?');
    await view.unmount();
  });

  it('renders no dropdown when the kind has no options, or none were loaded', async () => {
    for (const list of [[presets[2]!], []] as const) {
      const view = await mountForm(<Host list={list} />);
      expect(chosenValue()).toBeUndefined();
      await view.unmount();
    }
    const view = await mountForm(
      <SavedOptionsSelect kind="scope" presets={null} value="" maxLength={10} onFill={() => {}} />,
    );
    expect(chosenValue()).toBeUndefined();
    await view.unmount();
  });
});
