// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DISPOSE_KEY = Symbol.for('bos.dev.menu.dispose');

function chipRoot(): HTMLElement {
  const host = document.querySelector('[data-marker="BOS_DEV_MENU"]');
  const root = host?.shadowRoot?.querySelector<HTMLElement>('#bos-dev-root');
  if (!root) throw new Error('The Dev chip is not mounted');
  return root;
}

// The chip sat on the "Clear date" button of the preview dialog (I-N3): while a modal is open it must be hidden.
describe('Dev chip next to a modal dialog', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.resetModules();
    await import('./dev-menu');
    await vi.advanceTimersByTimeAsync(1500);
  });

  afterEach(() => {
    (globalThis as Record<symbol, (() => void) | undefined>)[DISPOSE_KEY]?.();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hides while a Radix dialog is open and returns when it closes', async () => {
    expect(chipRoot().hidden).toBe(false);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(true);

    dialog.setAttribute('data-state', 'closed');
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(false);

    dialog.remove();
  });

  it('stays hidden until the last of two stacked dialogs is gone', async () => {
    const first = document.createElement('div');
    first.setAttribute('role', 'dialog');
    first.setAttribute('data-state', 'open');
    const second = first.cloneNode() as HTMLElement;
    document.body.append(first, second);
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(true);

    first.remove();
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(true);

    second.remove();
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(false);
  });

  it('is not hidden by a closed dialog left in the page', async () => {
    const closed = document.createElement('div');
    closed.setAttribute('role', 'dialog');
    closed.setAttribute('data-state', 'closed');
    document.body.append(closed);
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(false);
  });

  it('is not hidden by a popover, which is a role=dialog inside a popper wrapper', async () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    const popover = document.createElement('div');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('data-state', 'open');
    wrapper.append(popover);
    document.body.append(wrapper);
    await vi.advanceTimersByTimeAsync(10);
    expect(chipRoot().hidden).toBe(false);
  });
});
