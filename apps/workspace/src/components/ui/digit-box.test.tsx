// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm, paste, typeKeys } from '@/test/form-interactions';
import { DigitBox } from './digit-box';
import { NEPAL_RULES, PhoneInput } from './phone-input';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
let root: Root | null = null;
let mounted: Awaited<ReturnType<typeof mountForm>> | null = null;
afterEach(async () => {
  if (root) await act(() => Promise.resolve(root!.unmount()));
  root = null;
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

/** Server-renders `node`, types `typed` into its box as a user would before the scripts load, then hydrates. */
async function hydrateWithTyped(node: ReactNode, typed: string) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(node);
  document.body.append(container);
  const box = container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
  box.value = typed;
  await act(() => {
    root = hydrateRoot(container, node, { onRecoverableError: () => {} });
    return Promise.resolve();
  });
  return {
    box: () => container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!,
    hidden: () => container.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
  };
}

/** Re-renders on demand, so a test can show the typed text survives the next render too. */
const control = { rerender: () => {} };
function Rerenders({ children }: { children: ReactNode }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    control.rerender = () => setTick((tick) => tick + 1);
  }, []);
  return <form>{children}</form>;
}

describe('DigitBox, text typed before hydration', () => {
  it('keeps a phone number typed before the page finished loading', async () => {
    const changes: string[] = [];
    const phone = await hydrateWithTyped(
      <Rerenders>
        <PhoneInput aria-label="Phone" name="phone" onValueChange={(v) => changes.push(v)} />
      </Rerenders>,
      '9812345678',
    );
    expect(phone.hidden()).toBe('+9779812345678');
    expect(changes).toEqual(['+9779812345678']);
    await act(() => Promise.resolve(control.rerender()));
    expect(phone.box().value).toBe('9812345678');
    expect(phone.hidden()).toBe('+9779812345678');
  });

  it('cleans a pre-typed number the way a whole paste is cleaned', async () => {
    const phone = await hydrateWithTyped(
      <Rerenders>
        <PhoneInput aria-label="Phone" name="phone" />
      </Rerenders>,
      '+977 98-1234 5678',
    );
    expect(phone.box().value).toBe('9812345678');
    expect(phone.hidden()).toBe('+9779812345678');
  });

  it('keeps pre-typed text the rules refuse as given, and flags it', async () => {
    const phone = await hydrateWithTyped(
      <Rerenders>
        <PhoneInput aria-label="Phone" name="phone" />
      </Rerenders>,
      '98abc',
    );
    expect(phone.box().value).toBe('98abc');
    expect(phone.box().getAttribute('aria-invalid')).toBe('true');
  });

  it('leaves a box nobody typed into alone', async () => {
    const phone = await hydrateWithTyped(
      <Rerenders>
        <PhoneInput aria-label="Phone" name="phone" defaultValue="+9779812345678" />
      </Rerenders>,
      '9812345678',
    );
    expect(phone.hidden()).toBe('+9779812345678');
    expect(phone.box().getAttribute('aria-invalid')).toBeNull();
  });
});

describe('DigitBox, onPlus', () => {
  async function mount(onPlus: (digits: string) => void) {
    mounted = await mountForm(
      <form>
        <DigitBox
          aria-label="Phone"
          name="phone"
          rules={NEPAL_RULES}
          prefix="+977"
          onPlus={onPlus}
        />
      </form>,
    );
    return mounted.container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
  }

  it('hands a + typed into the empty box to the caller instead of refusing it', async () => {
    const onPlus = vi.fn();
    const box = await mount(onPlus);
    await typeKeys(box, '+');
    expect(onPlus).toHaveBeenCalledWith('');
    expect(box.value).toBe('');
    expect(mounted!.container.querySelector('[role="status"]')!.textContent).toBe('');
  });

  it('hands a whole pasted international number over as its digits', async () => {
    const onPlus = vi.fn();
    const box = await mount(onPlus);
    await paste(box, '+1 (415) 555-2671');
    expect(onPlus).toHaveBeenCalledWith('14155552671');
    await paste(box, '00977 9812345678');
    expect(onPlus).toHaveBeenLastCalledWith('9779812345678');
  });

  it('still refuses a + typed after digits', async () => {
    const onPlus = vi.fn();
    const box = await mount(onPlus);
    await typeKeys(box, '98+');
    expect(onPlus).not.toHaveBeenCalled();
    expect(box.value).toBe('98');
  });
});
