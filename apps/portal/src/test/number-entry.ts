import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// What the portal's form tests need to enter numbers the way a browser does, with real React
// handlers and native form serialization (no browser). The fuller keyboard helpers are in
// components/ui/number-input.test.tsx.

export async function mountNode(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() => Promise.resolve(root.render(node)));
  return {
    container,
    async unmount() {
      await act(() => Promise.resolve(root.unmount()));
      container.remove();
    },
  };
}

/** The visible box of the field with this label: the input its `<label for>` names. */
export function boxOf(container: HTMLElement, label: string): HTMLInputElement {
  const found = [...container.querySelectorAll('label')].find((l) => l.textContent === label);
  const box = found ? document.getElementById(found.htmlFor) : null;
  if (!(box instanceof HTMLInputElement)) throw new Error(`No input labelled "${label}"`);
  return box;
}

/** What the form would post under `name`. */
export function posted(container: HTMLElement, name: string): FormDataEntryValue | null {
  return new FormData(container.querySelector('form')!).get(name);
}

/** Sets the text as one edit and fires `input`, the way `fill` does in the workspace helpers. */
export async function fill(box: HTMLInputElement, value: string) {
  if (document.activeElement !== box) await act(() => Promise.resolve(box.focus()));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, value);
  await act(() => {
    const event = new Event('input', { bubbles: true });
    Object.defineProperties(event, {
      inputType: { value: 'insertText' },
      data: { value: value.at(-1) ?? null },
    });
    box.dispatchEvent(event);
    return Promise.resolve();
  });
  await settle();
}

/** Pastes `text` over the box's selection; a handler that takes the paste prevents the default. */
export async function paste(box: HTMLInputElement, text: string) {
  if (document.activeElement !== box) await act(() => Promise.resolve(box.focus()));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : '') },
  });
  await act(() => Promise.resolve(box.dispatchEvent(event)));
  if (!event.defaultPrevented) {
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? start;
    const next = box.value.slice(0, start) + text + box.value.slice(end);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, next);
    await act(() => {
      const input = new Event('input', { bubbles: true });
      Object.defineProperties(input, {
        inputType: { value: 'insertFromPaste' },
        data: { value: text },
      });
      box.dispatchEvent(input);
      return Promise.resolve();
    });
  }
  await settle();
}

export async function settle() {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
