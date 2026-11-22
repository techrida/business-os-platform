// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { FocusOnArrival } from './focus-on-arrival';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('FocusOnArrival', () => {
  it('moves focus from the body to the page heading, without adding a tab stop', async () => {
    const mounted = await mountForm(
      <main>
        <h1>PAY-0001</h1>
        <button type="button">Verify</button>
        <FocusOnArrival />
      </main>,
    );
    try {
      const heading = document.querySelector('h1');
      expect(document.activeElement).toBe(heading);
      expect(heading?.getAttribute('tabindex')).toBe('-1');
    } finally {
      await mounted.unmount();
    }
  });

  it('leaves focus alone when a control already has it', async () => {
    const holder = document.createElement('button');
    document.body.append(holder);
    holder.focus();
    const mounted = await mountForm(
      <main>
        <h1>PAY-0001</h1>
        <FocusOnArrival />
      </main>,
    );
    try {
      expect(document.activeElement).toBe(holder);
    } finally {
      await mounted.unmount();
    }
  });
});
