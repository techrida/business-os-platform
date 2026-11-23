// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm as mountRaw } from '@/test/form-interactions';

import { Tooltip, TooltipProvider } from './tooltip';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.useFakeTimers();
});
async function mountForm(node: ReactNode) {
  const view = await mountRaw(node);
  views.push(view);
  return view;
}

let views: { unmount(): Promise<void> }[] = [];
afterEach(async () => {
  for (const view of views) await view.unmount();
  views = [];
  vi.useRealTimers();
});

const bubble = () => document.querySelector('[data-state][role="tooltip"], [role="tooltip"]');
const visible = () => document.body.querySelector<HTMLElement>('[data-side]');

async function hover(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

it('opens on hover only after the delay', async () => {
  await mountForm(
    <TooltipProvider>
      <Tooltip content="Sorted by newest">
        <button type="button">Sort</button>
      </Tooltip>
    </TooltipProvider>,
  );
  const button = document.querySelector('button')!;
  await hover(button);
  expect(visible()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(350));
  expect(visible()?.textContent).toContain('Sorted by newest');
});

it('opens at once on keyboard focus, links the bubble with aria-describedby, closes on Escape', async () => {
  await mountForm(
    <Tooltip content="Export as PDF">
      <button type="button">Export</button>
    </Tooltip>,
  );
  const button = document.querySelector('button')!;
  await act(async () => {
    button.focus();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(visible()?.textContent).toContain('Export as PDF');
  const id = button.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  expect(document.getElementById(id!)?.textContent).toContain('Export as PDF');
  expect(bubble()).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(visible()).toBeNull();
});

it('explains an aria-disabled trigger, which stays focusable', async () => {
  const onClick = vi.fn();
  await mountForm(
    <Tooltip content="Add a customer first">
      <button type="button" aria-disabled="true" onClick={onClick}>
        Create invoice
      </button>
    </Tooltip>,
  );
  const button = document.querySelector('button')!;
  await act(async () => {
    button.focus();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(document.activeElement).toBe(button);
  expect(visible()?.textContent).toContain('Add a customer first');
});

it('renders the child alone when there is no content', async () => {
  await mountForm(
    <Tooltip content="">
      <button type="button">Plain</button>
    </Tooltip>,
  );
  const button = document.querySelector('button')!;
  await act(async () => {
    button.focus();
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(visible()).toBeNull();
  expect(button.getAttribute('aria-describedby')).toBeNull();
});
