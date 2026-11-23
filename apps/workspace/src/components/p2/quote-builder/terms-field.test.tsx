// @vitest-environment jsdom
import type { TermPreset } from '@bos/contracts';
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Field } from '@/components/ui/field';
import { choose, click, mountForm } from '@/test/form-interactions';

import { TermsField } from './terms-field';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const make = (n: number, name: string, body: string): TermPreset => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'terms_conditions',
  name,
  body,
});
const net30 = make(1, 'Net 30', '<p>Pay within <strong>30</strong> days.</p>');
const lists = make(2, 'Two lists', '<ol><li>First</li><li>Second</li></ol><ul><li>Extra</li></ul>');
const plain = make(3, 'Older plain set', 'Pay on delivery.');
const sets = [net30, lists, plain];

function Host({
  canAddTerms = false,
  list = sets,
  initial = '',
}: {
  canAddTerms?: boolean;
  list?: readonly TermPreset[] | null;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <Field label="Terms and conditions">
        {(control) => (
          <TermsField
            kind="terms_conditions"
            presets={list}
            canAddTerms={canAddTerms}
            value={value}
            onChange={setValue}
            maxChars={10_000}
            control={control}
          />
        )}
      </Field>
      <output data-testid="value">{value}</output>
    </div>
  );
}

const NAME = 'saved-terms_conditions';
const pick = (preset: TermPreset) => choose(document.body, NAME, preset.name);
const stored = () => document.querySelector('[data-testid="value"]')?.textContent;
const surface = () => document.querySelector<HTMLElement>('[role="textbox"]');
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
const bulletList = () =>
  document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="Bulleted list"]');
const asked = () => document.body.textContent?.includes('Replace the text you typed?');

// The editor is created after mount (no server render), so give it a moment to attach.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeEach(() => {
  vi.clearAllMocks();
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

describe('TermsField', () => {
  it('fills the editor with the picked set, lists and bold included', async () => {
    const view = await mountForm(<Host />);
    await settle();
    await pick(lists);
    await settle();
    expect(stored()).toBe(lists.body);
    expect(surface()?.querySelectorAll('ol li')).toHaveLength(2);
    expect(surface()?.querySelectorAll('ul li')).toHaveLength(1);

    await pick(net30);
    await settle();
    expect(stored()).toBe(net30.body);
    expect(surface()?.querySelector('strong')?.textContent).toBe('30');
    expect(asked()).toBeFalsy();
    await view.unmount();
  });

  it('opens a set that was saved as plain text in the editor as paragraphs', async () => {
    const view = await mountForm(<Host />);
    await settle();
    await pick(plain);
    await settle();
    expect(stored()).toBe('Pay on delivery.');
    expect([...(surface()?.querySelectorAll('p') ?? [])].map((p) => p.textContent)).toEqual([
      'Pay on delivery.',
    ]);
    await view.unmount();
  });

  it('picking another set right after a fill does not ask, even though the editor normalised the HTML', async () => {
    const view = await mountForm(<Host />);
    await settle();
    await pick(net30);
    await settle();
    await pick(lists);
    await settle();
    expect(asked()).toBeFalsy();
    expect(stored()).toBe(lists.body);
    await view.unmount();
  });

  it('asks before replacing text that was edited after a fill', async () => {
    const view = await mountForm(<Host />);
    await settle();
    await pick(net30);
    await settle();
    // Turning the paragraph into a bulleted list changes what the field says.
    await click(bulletList());
    await settle();
    expect(stored()).toContain('<ul>');

    await pick(lists);
    await settle();
    expect(asked()).toBe(true);
    expect(stored()).toContain('<ul>');
    expect(stored()).not.toBe(lists.body);

    await click(button('Keep my text'));
    await settle();
    expect(asked()).toBeFalsy();
    expect(stored()).not.toBe(lists.body);

    await pick(lists);
    await settle();
    await click(button('Replace text'));
    await settle();
    expect(stored()).toBe(lists.body);
    await view.unmount();
  });

  it('asks before replacing text that arrived with a saved draft', async () => {
    const view = await mountForm(<Host initial="<p>Drafted earlier</p>" />);
    await settle();
    await pick(net30);
    await settle();
    expect(asked()).toBe(true);
    await view.unmount();
  });

  it('gives the Founder an "Add more" entry that opens Settings > Saved terms in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const view = await mountForm(<Host canAddTerms />);
    await settle();
    await choose(document.body, NAME, 'Add more');
    // A new tab, so an unsaved quotation is never thrown away; reload this page to see new sets.
    expect(open).toHaveBeenCalledWith('/settings/terms', '_blank', 'noopener');
    expect(router.push).not.toHaveBeenCalled();
    expect(stored()).toBe('');
    await view.unmount();
  });

  it('does not show "Add more" to anyone else', async () => {
    const view = await mountForm(<Host canAddTerms={false} />);
    await settle();
    const trigger = document
      .querySelector(`input[type="hidden"][name="${NAME}"]`)
      ?.parentElement?.querySelector('button');
    await click(trigger ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Net 30', 'Older plain set', 'Two lists']);
    await view.unmount();
  });

  it('names the editor by its field label', async () => {
    const view = await mountForm(<Host />);
    await settle();
    const label = document.querySelector('label');
    expect(surface()?.getAttribute('aria-labelledby')).toBe(label?.id);
    await view.unmount();
  });
});
