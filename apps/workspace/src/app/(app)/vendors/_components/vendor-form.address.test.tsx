// @vitest-environment jsdom
// FX9: the vendor's country is the address's Country, the address itself is optional but whole (street and
// city together), and a foreign vendor may give a loose tax id. Each test goes rendered form -> FormData -> the
// action's own reader and parser, so what the browser posts is what the API body is built from.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';

import {
  EMPTY_VENDOR_VALUES,
  parseCreateVendor,
  readVendorValues,
  type VendorValues,
} from '../_lib/forms';
import type { VendorFormState } from '../_lib/state';
import { VendorForm } from './vendor-form';

const action = vi.fn<(prev: VendorFormState, form: FormData) => Promise<VendorFormState>>();

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The server action's validation, without the network: refuse with field errors, else keep the state.
  action.mockImplementation((prev, form) => {
    const parsed = parseCreateVendor(readVendorValues(form));
    return Promise.resolve(parsed.ok ? prev : { key: prev.key, errors: parsed.errors });
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fillText(element: Element | null, value: string) {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('Missing textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    element,
    value,
  );
  await act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return Promise.resolve();
  });
}

async function mount(initial: VendorValues) {
  mounted = await mountForm(
    <VendorForm
      title="Add vendor"
      action={action}
      mode="create"
      initial={initial}
      idempotencyKey="key-1"
      cancelHref="/vendors"
      reloadHref="/vendors/new"
    />,
  );
  return mounted.container;
}

const posted = (): FormData => {
  const call = action.mock.calls.at(-1);
  if (call === undefined) throw new Error('The form did not submit');
  return call[1];
};

describe('vendor form, country and address', () => {
  it('a foreign vendor with a loose tax ID and an address saves', async () => {
    const container = await mount({
      ...EMPTY_VENDOR_VALUES,
      legalName: 'Acme Inc.',
      kind: 'foreign',
      country: 'US',
    });
    await fill(container.querySelector('input[name="pan"]'), '12-3456789');
    await fillText(container.querySelector('textarea[name="address.line"]'), '500 Howard Street');
    await fill(container.querySelector('input[name="address.city"]'), 'San Francisco');
    await submit(container);

    expect(parseCreateVendor(readVendorValues(posted()))).toEqual({
      ok: true,
      data: {
        legalName: 'Acme Inc.',
        kind: 'foreign',
        pan: '12-3456789',
        vatRegistered: false,
        country: 'US',
        address: { line: '500 Howard Street', city: 'San Francisco' },
      },
    });
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it('an address with only a street cannot be saved, and the City says why', async () => {
    const container = await mount({
      ...EMPTY_VENDOR_VALUES,
      legalName: 'Himal Traders',
      pan: '301234567',
    });
    await fillText(container.querySelector('textarea[name="address.line"]'), 'Thamel Marg');
    await submit(container);

    expect(parseCreateVendor(readVendorValues(posted())).ok).toBe(false);
    const city = container.querySelector<HTMLInputElement>('input[name="address.city"]')!;
    expect(city.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(city);
    expect(container.textContent).toContain('Enter the city too, or clear the address.');
    // What was typed survives the refusal.
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[name="address.line"]')!.value,
    ).toBe('Thamel Marg');
  });
});
