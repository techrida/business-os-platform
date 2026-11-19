// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { Disclosure } from './disclosure';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

const trigger = () => document.querySelector<HTMLButtonElement>('button');

it('is collapsed by default, opens and closes, and keeps aria-expanded and aria-controls in step', async () => {
  const view = await mountForm(
    <Disclosure title="Details">
      <p>Memo version 3</p>
    </Disclosure>,
  );
  const button = trigger();
  expect(button?.textContent).toBe('Details');
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  const panelId = button?.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  const panel = () => document.getElementById(panelId!);
  expect(panel()?.hasAttribute('hidden')).toBe(true);

  await click(button);
  expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
  expect(panel()?.hasAttribute('hidden')).toBe(false);
  expect(panel()?.textContent).toContain('Memo version 3');

  await click(trigger());
  expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
  expect(panel()?.hasAttribute('hidden')).toBe(true);
  await view.unmount();
});
