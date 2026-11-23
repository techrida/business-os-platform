// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { HeaderAction } from './header-action';

// UIP-FORM-011: nothing is printed beside a blocked header button. What is missing is read out through
// aria-describedby and listed in the popover that opens when the button is activated.
let view: { unmount(): Promise<void> } | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

it('prints no pills beside a blocked button, but still explains what is missing on activation', async () => {
  const onClick = vi.fn();
  view = await mountForm(
    <HeaderAction missing={['Subject', 'Approver']} onClick={onClick}>
      Submit for review
    </HeaderAction>,
  );
  const button = document.querySelector('button')!;
  expect(button.getAttribute('aria-disabled')).toBe('true');
  // No visible list beside the button (the old red pills).
  expect(document.querySelector('ul')).toBeNull();
  expect(document.body.textContent).not.toContain('SubjectApprover');
  await act(() => Promise.resolve(button.click()));
  expect(onClick).not.toHaveBeenCalled();
  const popover = document.querySelector('[role="dialog"]');
  expect(popover?.textContent).toContain('Subject');
  expect(popover?.textContent).toContain('Approver');
});
