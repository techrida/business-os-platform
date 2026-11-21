import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// Run real React handlers and native form serialization without a browser or server.
export async function mountForm(node: ReactNode) {
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

export async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('Missing clickable element');
  await act(() => Promise.resolve(element.click()));
}

export async function fill(element: Element | null, value: string) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) {
    throw new Error('Missing form control');
  }
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(() => {
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
    return Promise.resolve();
  });
}

export async function submit(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(() => Promise.resolve(form.requestSubmit()));
}

const SPECIAL_KEYS = /\{(Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)\}/y;

function inputEvent(type: 'beforeinput' | 'input', inputType: string, data: string | null) {
  // jsdom's InputEvent may not carry inputType; set both fields so handlers read what a browser sends.
  const event = new Event(type, { bubbles: true, cancelable: type === 'beforeinput' });
  Object.defineProperties(event, {
    inputType: { value: inputType },
    data: { value: data },
  });
  return event;
}

/** Waits out the 0 ms timers inputs use to re-apply the caret after a change. */
export async function settle() {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * Types into a text input the way a browser does, one key at a time: keydown, then (unless a
 * handler prevented it) beforeinput, then the edit at the current selection and an input event.
 * The selection is read after keydown, because inputs may move the caret there and leave the
 * deletion to the browser. `{Backspace}`, `{Delete}` and the arrow keys are named in braces:
 * `typeKeys(box, '12{Backspace}5')`.
 */
export async function typeKeys(
  element: Element | null,
  text: string,
  options: { settleEach?: boolean } = {},
) {
  if (!(element instanceof HTMLInputElement)) throw new Error('Missing text input');
  if (document.activeElement !== element) await act(() => Promise.resolve(element.focus()));
  let index = 0;
  while (index < text.length) {
    SPECIAL_KEYS.lastIndex = index;
    const special = SPECIAL_KEYS.exec(text);
    const key = special ? special[1]! : text[index]!;
    index = special ? SPECIAL_KEYS.lastIndex : index + 1;
    const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(() => Promise.resolve(element.dispatchEvent(down)));
    if (down.defaultPrevented) continue;
    const value = element.value;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    if (key === 'ArrowUp' || key === 'ArrowDown') continue;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const to = key === 'ArrowLeft' ? Math.max(start - 1, 0) : Math.min(end + 1, value.length);
      element.setSelectionRange(to, to);
      continue;
    }
    let next: string;
    let caret: number;
    let inputType: string;
    let data: string | null = null;
    if (key === 'Backspace' || key === 'Delete') {
      inputType = key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
      const from = start !== end ? start : key === 'Backspace' ? Math.max(start - 1, 0) : start;
      const to =
        start !== end ? end : key === 'Backspace' ? start : Math.min(start + 1, value.length);
      if (from === to) continue;
      next = value.slice(0, from) + value.slice(to);
      caret = from;
    } else {
      inputType = 'insertText';
      data = key;
      next = value.slice(0, start) + key + value.slice(end);
      caret = start + key.length;
    }
    const before = inputEvent('beforeinput', inputType, data);
    await act(() => Promise.resolve(element.dispatchEvent(before)));
    if (before.defaultPrevented) continue;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, next);
    element.setSelectionRange(caret, caret);
    await act(() => Promise.resolve(element.dispatchEvent(inputEvent('input', inputType, data))));
    // Lets the library's 0 ms caret timer run between keys, as it does between real keystrokes.
    if (options.settleEach) await settle();
  }
  await settle();
}

/**
 * Pastes `text` at the input's selection. A paste handler reads it from `clipboardData`; if no
 * handler prevents the event, the browser's own insertion happens and an input event follows,
 * so a field that does not intercept paste shows what a real browser would do with the text.
 */
export async function paste(element: Element | null, text: string) {
  if (!(element instanceof HTMLInputElement)) throw new Error('Missing text input');
  if (document.activeElement !== element) await act(() => Promise.resolve(element.focus()));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : '') },
  });
  await act(() => Promise.resolve(element.dispatchEvent(event)));
  if (!event.defaultPrevented) {
    const value = element.value;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    const next = value.slice(0, start) + text + value.slice(end);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, next);
    element.setSelectionRange(start + text.length, start + text.length);
    await act(() =>
      Promise.resolve(element.dispatchEvent(inputEvent('input', 'insertFromPaste', text))),
    );
  }
  await settle();
}

/**
 * Pick an option in the shared Select the way a user does: open the trigger, click the option.
 * `name` is the form field name; `label` is the option's visible text.
 */
export async function choose(container: HTMLElement, name: string, label: string) {
  const field = container.querySelector(`input[type="hidden"][name="${name}"]`);
  const trigger = field?.parentElement?.querySelector('button');
  if (!trigger) throw new Error(`No Select named ${name}`);
  await click(trigger);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent?.trim() === label,
  );
  if (!option) throw new Error(`No option "${label}" in ${name}`);
  await click(option);
}

/**
 * Drops `text` onto the input. A drop handler reads it from `dataTransfer`; if none prevents the
 * event, the browser's insertion at the selection happens and an input event follows with no data,
 * the way a drag-and-drop reaches a field without keydown or a cancellable beforeinput.
 */
export async function drop(element: Element | null, text: string) {
  if (!(element instanceof HTMLInputElement)) throw new Error('Missing text input');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : '') },
  });
  await act(() => Promise.resolve(element.dispatchEvent(event)));
  if (!event.defaultPrevented) {
    const value = element.value;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value.slice(0, start) + text + value.slice(end),
    );
    await act(() =>
      Promise.resolve(element.dispatchEvent(inputEvent('input', 'insertFromDrop', null))),
    );
  }
  await settle();
}

/**
 * An Android soft-keyboard edit: keydown reports "Unidentified", so only beforeinput says what
 * happens. Unless a handler prevents it, the browser deletes or inserts at the selection as it
 * stood when beforeinput was dispatched, then sends input.
 */
export async function softKey(
  element: Element | null,
  inputType: 'deleteContentBackward' | 'deleteContentForward',
) {
  if (!(element instanceof HTMLInputElement)) throw new Error('Missing text input');
  const value = element.value;
  const start = element.selectionStart ?? value.length;
  const end = element.selectionEnd ?? start;
  const down = new KeyboardEvent('keydown', {
    key: 'Unidentified',
    bubbles: true,
    cancelable: true,
  });
  await act(() => Promise.resolve(element.dispatchEvent(down)));
  const before = inputEvent('beforeinput', inputType, null);
  await act(() => Promise.resolve(element.dispatchEvent(before)));
  if (!before.defaultPrevented) {
    const back = inputType === 'deleteContentBackward';
    const from = start !== end ? start : back ? Math.max(start - 1, 0) : start;
    const to = start !== end ? end : back ? start : Math.min(start + 1, value.length);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      value.slice(0, from) + value.slice(to),
    );
    element.setSelectionRange(from, from);
    await act(() => Promise.resolve(element.dispatchEvent(inputEvent('input', inputType, null))));
  }
  await settle();
}
