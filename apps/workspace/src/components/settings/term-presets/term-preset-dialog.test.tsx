// @vitest-environment jsdom
import type { TermPreset } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionState } from '@/app/(app)/settings/action-state';
import { mountForm } from '@/test/form-interactions';

import { TermPresetDialog } from './term-preset-dialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const save = vi.hoisted(() => vi.fn());
vi.mock('@/app/(app)/settings/terms/actions', () => ({ savePresetAction: save }));

// The real editor needs a browser's text editing (its own tests live beside it). This stand-in is a
// plain text box that reports whatever is typed, unsanitised, so what reaches the action is the
// dialog's own doing: it must send the contract's cleaned text, not the raw value.
vi.mock('@/components/ui/rich-text-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/rich-text-editor')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    RichTextEditor: (props: {
      id?: string;
      value: string;
      maxChars: number;
      onChange: (html: string) => void;
    }) =>
      createElement('textarea', {
        id: props.id,
        'data-testid': 'editor',
        'data-max': props.maxChars,
        value: props.value,
        onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
      }),
  };
});

const ID = '11111111-1111-4111-8111-111111111111';
const preset: TermPreset = {
  id: ID,
  kind: 'scope',
  name: 'Standard build',
  body: '<p>We build it.</p>',
};

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout: the dialog and select ask for these.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function open(props: { kind?: TermPreset['kind']; preset?: TermPreset }) {
  mounted = await mountForm(
    <TermPresetDialog kind={props.kind ?? 'scope'} preset={props.preset} onClose={onClose} />,
  );
}

const nameInput = () => document.querySelector<HTMLInputElement>('form input')!;
const editor = () => document.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!;
const saveButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('form') === 'term-preset-form',
  )!;

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return Promise.resolve();
  });
}

async function submitForm() {
  const form = document.querySelector('form')!;
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
}

describe('the term set dialog', () => {
  it('uses the rich text editor, capped at the kind limit (delivery timeline 2,000, others 10,000)', async () => {
    await open({ kind: 'delivery_timeline' });
    expect(editor().getAttribute('data-max')).toBe('2000');
    await mounted?.unmount();
    await open({ kind: 'terms_conditions' });
    expect(editor().getAttribute('data-max')).toBe('10000');
    expect(document.querySelector('textarea[rows]')).toBeNull();
  });

  it('keeps Save in the fixed footer, and on an edit only enabled once something changed', async () => {
    await open({ preset });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Edit term set');
    expect(saveButton().disabled).toBe(true);
    await type(nameInput(), 'Standard build 2');
    expect(saveButton().disabled).toBe(false);
  });

  it('sends sanitised rich text: a script or handler typed into the text never reaches the action', async () => {
    save.mockResolvedValue({ status: 'ok', message: 'Term set added.' } satisfies ActionState);
    await open({});
    await type(nameInput(), 'Casual website terms');
    await type(
      editor(),
      '<p onclick="steal()">Pay <strong>half</strong> first.</p><script>alert(1)</script>',
    );
    await submitForm();
    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0]?.[0] as { body: string; name: string; kind: string };
    expect(payload).toMatchObject({
      kind: 'scope',
      name: 'Casual website terms',
      body: '<p>Pay <strong>half</strong> first.</p>',
    });
    expect(payload.body).not.toMatch(/script|onclick|alert/);
    expect(toast.success).toHaveBeenCalledWith('Term set added.');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says a taken name at the name field, keeps the dialog open and the typed text', async () => {
    save.mockResolvedValue({
      status: 'error',
      message: 'There is already a term set named "Standard build" in Scope. Choose another name.',
      fieldErrors: { name: 'This name is already used here. Choose another.' },
    } satisfies ActionState);
    await open({});
    await type(nameInput(), 'Standard build');
    await type(editor(), '<p>Text</p>');
    await submitForm();
    expect(document.body.textContent).toContain('This name is already used here. Choose another.');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('Standard build');
    expect(editor().value).toBe('<p>Text</p>');
  });

  it('asks for a name and for text at the fields before calling the action', async () => {
    await open({});
    await submitForm();
    expect(document.body.textContent).toContain('Give this term set a name');
    expect(document.body.textContent).toContain('Write the text this term set fills in.');
    expect(save).not.toHaveBeenCalled();
  });
});
