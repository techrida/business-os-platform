// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import {
  countRichTextChars,
  RichTextEditor,
  toEditorHtml,
  toStoredValue,
} from './rich-text-editor';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

// The editor is created after mount (no server render), so give it a moment to attach.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const buttons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'));
const surface = () => document.querySelector<HTMLElement>('[role="textbox"]');

describe('rich text helpers', () => {
  it('opens legacy plain text as escaped paragraphs and keeps rich text', () => {
    expect(toEditorHtml('Net 30')).toBe('<p>Net 30</p>');
    expect(toEditorHtml('a <b> c')).toBe('<p>a &lt;b&gt; c</p>');
    expect(toEditorHtml('<p>Hi</p>')).toBe('<p>Hi</p>');
    expect(toEditorHtml('')).toBe('');
  });

  it('reports an empty document as an empty string', () => {
    expect(toStoredValue('<p></p>')).toBe('');
    expect(toStoredValue('<p><br></p>')).toBe('');
    expect(toStoredValue('<ul><li><p></p></li></ul>')).toBe('');
    expect(toStoredValue('')).toBe('');
  });

  it('reports sanitised html', () => {
    expect(toStoredValue('<p>Hi <strong>there</strong></p>')).toContain('<strong>there</strong>');
    expect(toStoredValue('<p onclick="x()">Hi</p><script>alert(1)</script>')).toBe('<p>Hi</p>');
  });

  it('counts the words, not the markup', () => {
    expect(countRichTextChars('<p>abc</p>')).toBe(3);
    expect(countRichTextChars('<p><strong>abc</strong></p>')).toBe(3);
    expect(countRichTextChars('plain')).toBe(5);
    expect(countRichTextChars('')).toBe(0);
    expect(countRichTextChars(null)).toBe(0);
  });
});

describe('RichTextEditor', () => {
  it('renders a toolbar of labelled toggle buttons with tooltips', async () => {
    const view = await mountForm(<RichTextEditor value="" onChange={() => {}} maxChars={100} />);
    await settle();
    const bar = document.querySelector('[role="toolbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Text formatting');
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Bold',
      'Italic',
      'Bulleted list',
      'Numbered list',
    ]);
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    // The shortcut hint is the design-system Tooltip (shown on focus), not a native title.
    expect(buttons().some((b) => b.hasAttribute('title'))).toBe(false);
    await act(() => Promise.resolve(buttons()[0]?.focus()));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Bold (Ctrl+B)');
    expect(buttons().every((b) => b.type === 'button')).toBe(true);
    // One tab stop for the toolbar.
    expect(buttons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    await view.unmount();
  });

  it('opens a legacy plain text value as paragraphs', async () => {
    const view = await mountForm(
      <RichTextEditor value={'Net 30 days\n\nPay <on> time'} onChange={() => {}} maxChars={100} />,
    );
    await settle();
    const paragraphs = Array.from(surface()?.querySelectorAll('p') ?? []).map((p) => p.textContent);
    expect(paragraphs).toEqual(['Net 30 days', 'Pay <on> time']);
    await view.unmount();
  });

  it('names the text box, links the counter and flags a value over the limit', async () => {
    const view = await mountForm(
      <RichTextEditor
        id="terms"
        label="Terms"
        aria-describedby="hint"
        value="<p>abcdef</p>"
        onChange={() => {}}
        maxChars={3}
      />,
    );
    await settle();
    const box = surface();
    expect(box?.id).toBe('terms');
    expect(box?.getAttribute('aria-label')).toBe('Terms');
    expect(box?.getAttribute('aria-multiline')).toBe('true');
    expect(box?.getAttribute('aria-invalid')).toBe('true');
    expect(box?.getAttribute('aria-describedby')).toContain('hint');
    const counter = document.querySelector('[data-over]');
    expect(counter?.textContent).toContain('6 / 3');
    expect(box?.getAttribute('aria-describedby')).toContain(counter?.id ?? 'missing');
    await view.unmount();
  });

  it('shows "n / max" without an error while within the limit', async () => {
    const view = await mountForm(
      <RichTextEditor value="<p>abc</p>" onChange={() => {}} maxChars={10} />,
    );
    await settle();
    expect(document.body.textContent).toContain('3 / 10');
    expect(document.querySelector('[data-over]')).toBeNull();
    expect(surface()?.getAttribute('aria-invalid')).toBeNull();
    await view.unmount();
  });

  it('writes a hidden input for form posts when it has a name', async () => {
    const view = await mountForm(
      <form>
        <RichTextEditor name="terms" value="<p>Hi</p>" onChange={() => {}} maxChars={10} />
      </form>,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="hidden"][name="terms"]');
    expect(input?.value).toBe('<p>Hi</p>');
    await view.unmount();
  });

  it('disables the toolbar when the field is disabled', async () => {
    const view = await mountForm(
      <RichTextEditor disabled value="<p>Hi</p>" onChange={() => {}} maxChars={10} />,
    );
    await settle();
    expect(buttons().every((b) => b.disabled)).toBe(true);
    expect(surface()?.getAttribute('contenteditable')).toBe('false');
    await view.unmount();
  });

  it('reports sanitised html through onChange when a toolbar action edits the document', async () => {
    const onChange = vi.fn();
    const view = await mountForm(
      <RichTextEditor value="Net 30 days" onChange={onChange} maxChars={100} />,
    );
    await settle();
    await click(buttons()[2] ?? null);
    await settle();
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] as string;
    expect(last).toContain('<ul>');
    expect(last).toContain('Net 30 days');
    expect(last).not.toContain('<p></p>');
    expect(buttons()[2]?.getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('takes a value that changes from outside without reporting it back', async () => {
    const onChange = vi.fn();
    let setValue: (next: string) => void = () => {};
    function Harness() {
      const [value, set] = useState('<p>Before</p>');
      setValue = set;
      return (
        <RichTextEditor
          name="terms"
          value={value}
          onChange={(next) => {
            onChange(next);
            set(next);
          }}
          maxChars={100}
        />
      );
    }
    const view = await mountForm(<Harness />);
    await settle();
    expect(surface()?.textContent).toBe('Before');

    await act(() => {
      setValue('<ul><li>One</li><li>Two</li></ul>');
      return Promise.resolve();
    });
    await settle();
    expect(surface()?.querySelectorAll('li')).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLInputElement>('input[type="hidden"][name="terms"]')?.value,
    ).toBe('<ul><li>One</li><li>Two</li></ul>');

    await act(() => {
      setValue('');
      return Promise.resolve();
    });
    await settle();
    expect(surface()?.textContent).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    await view.unmount();
  });
});
