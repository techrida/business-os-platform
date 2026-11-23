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
  onAddMore,
}: {
  list?: readonly TermPreset[];
  initial?: string;
  onAddMore?: () => void;
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
        onAddMore={onAddMore}
      />
      <textarea aria-label="Scope text" value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}

const NAME = 'saved-scope';
const pick = (preset: TermPreset) => choose(document.body, NAME, preset.name);
const chosenValue = () =>
  document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${NAME}"]`)?.value;
const shownLabel = () =>
  document
    .querySelector(`input[type="hidden"][name="${NAME}"]`)
    ?.parentElement?.querySelector('button')
    ?.textContent?.trim();
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
  it('lists this kind by name and nothing from other kinds', async () => {
    const view = await mountForm(<Host />);
    const trigger = document
      .querySelector(`input[type="hidden"][name="${NAME}"]`)
      ?.parentElement?.querySelector('button');
    await click(trigger ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Annual support', 'Standard build']);
    await view.unmount();
  });

  it('fills an empty field and leaves it editable', async () => {
    const view = await mountForm(<Host />);
    await pick(standard);
    expect(textarea().value).toBe('We build it.');
    expect(shownLabel()).toBe('Standard build');
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
    expect(shownLabel()).toBe('Custom');

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

  it('renders no dropdown when the presets did not load (null) or are missing', async () => {
    for (const list of [null, undefined] as const) {
      const view = await mountForm(
        <SavedOptionsSelect
          kind="scope"
          presets={list}
          value=""
          maxLength={10}
          onFill={() => {}}
        />,
      );
      expect(chosenValue()).toBeUndefined();
      await view.unmount();
    }
  });

  it('shows a disabled "No saved terms" select to a person who cannot add, when the kind has none', async () => {
    for (const list of [[presets[2]!], []] as const) {
      const view = await mountForm(<Host list={list} />);
      const trigger = document
        .querySelector(`input[type="hidden"][name="${NAME}"]`)
        ?.parentElement?.querySelector('button');
      expect(trigger?.disabled).toBe(true);
      expect(trigger?.textContent).toContain('No saved terms');
      await view.unmount();
    }
  });

  it('ends the list with "Add more" for a person who can add terms, and runs onAddMore on it', async () => {
    const onAddMore = vi.fn();
    const view = await mountForm(<Host onAddMore={onAddMore} />);
    const trigger = document
      .querySelector(`input[type="hidden"][name="${NAME}"]`)
      ?.parentElement?.querySelector('button');
    await click(trigger ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Annual support', 'Standard build', 'Add more']);
    await click(
      [...document.querySelectorAll('[role="option"]')].find(
        (o) => o.textContent?.trim() === 'Add more',
      ) ?? null,
    );
    expect(onAddMore).toHaveBeenCalledTimes(1);
    // It is an action, not a set: nothing was filled and nothing was asked.
    expect(textarea().value).toBe('');
    expect(chosenValue()).toBe('');
    await view.unmount();
  });

  it('offers only "Add more" when the kind has no sets and the person can add terms', async () => {
    const view = await mountForm(<Host list={[]} onAddMore={() => {}} />);
    const trigger = document
      .querySelector(`input[type="hidden"][name="${NAME}"]`)
      ?.parentElement?.querySelector('button');
    expect(trigger?.disabled).toBe(false);
    await click(trigger ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Add more']);
    await view.unmount();
  });

  it('asks for a choice when the field is empty, names the option after a fill, and says Custom once edited', async () => {
    const view = await mountForm(<Host />);
    expect(shownLabel()).toBe('Choose scope');
    await pick(standard);
    expect(shownLabel()).toBe('Standard build');
    await type('We build it. Plus training.');
    expect(shownLabel()).toBe('Custom');
    // Back to the words of the option: the name returns without choosing again.
    await type('We build it.');
    expect(shownLabel()).toBe('Standard build');
    await type('');
    expect(shownLabel()).toBe('Choose scope');
    await view.unmount();
  });

  it('names the option of a stored text, spacing and markup aside, and says Custom for other text', async () => {
    const view = await mountForm(<Host initial="<p>We   build it.</p>" />);
    expect(shownLabel()).toBe('Standard build');
    await view.unmount();
    const other = await mountForm(<Host initial="Something else" />);
    expect(shownLabel()).toBe('Custom');
    await other.unmount();
  });

  it('choosing the option already shown puts its text back; edits ask first', async () => {
    const view = await mountForm(<Host />);
    await pick(standard);
    await type('We build it, partly.');
    await pick(standard);
    await settle();
    expect(document.body.textContent).toContain('Replace the text you typed?');
    await click(button('Replace text'));
    await settle();
    expect(textarea().value).toBe(standard.body);
    expect(shownLabel()).toBe('Standard build');

    // Same option again with the text untouched: it simply sets it, with no question.
    await pick(standard);
    await settle();
    expect(document.body.textContent).not.toContain('Replace the text you typed?');
    expect(textarea().value).toBe(standard.body);
    await view.unmount();
  });

  it('choosing the shown option again resets the text to the saved wording exactly', async () => {
    const view = await mountForm(<Host initial="<p>We   build it.</p>" />);
    expect(shownLabel()).toBe('Standard build');
    await pick(standard);
    await settle();
    expect(textarea().value).toBe(standard.body);
    await view.unmount();
  });
});
