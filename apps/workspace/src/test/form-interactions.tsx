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
