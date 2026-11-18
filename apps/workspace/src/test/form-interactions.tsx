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
