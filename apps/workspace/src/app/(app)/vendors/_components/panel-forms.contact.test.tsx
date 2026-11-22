// @vitest-environment jsdom
// FX9: a vendor contact has its own country and several phones, each with its country. The test goes rendered
// form -> FormData -> the action's own reader and parser, so the API body is what the browser posted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit, typeKeys } from '@/test/form-interactions';

import { parseContact, readContactValues } from '../_lib/forms';
import type { PanelState } from '../_lib/state';
import { ContactForm } from './panel-forms';

const actions = vi.hoisted(() => ({
  addContactAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../actions', () => actions);
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ID = '11111111-1111-4111-8111-111111111111';

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
  // A refusal that keeps the form: what was typed must survive React's reset.
  actions.addContactAction.mockImplementation((prev: PanelState) =>
    Promise.resolve({ ...prev, errors: {}, error: 'The API is unreachable.' }),
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const number = (n: number) => q<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`);
const posted = (field: string) => q<HTMLInputElement>(`input[name="phones.${field}"]`)?.value;

describe('vendor contact form', () => {
  it('posts two phones in different countries, and a +1 number typed into a Nepal row as US', async () => {
    mounted = await mountForm(
      <ContactForm vendorId={ID} vendorCountry="NP" idempotencyKey="k-1" />,
    );
    expect(q('[aria-label="Phone 1 country"]')).not.toBeNull();
    await fill(q('input[name="name"]'), 'John Doe');
    // Row 1 starts in Nepal (the vendor's country); typing the +1 code switches it to the US.
    await typeKeys(number(1), '+');
    await typeKeys(number(1), '1 4155552671');
    expect(posted('0.country')).toBe('US');
    expect(posted('0.number')).toBe('+14155552671');
    await click(q('button[data-action="add"]'));
    await typeKeys(number(2), '9812345678');
    await submit(mounted.container);

    const call = actions.addContactAction.mock.calls.at(-1);
    expect(call).toBeDefined();
    expect(parseContact(readContactValues(call![1] as FormData))).toEqual({
      ok: true,
      data: {
        name: 'John Doe',
        country: 'NP',
        phones: [
          { country: 'US', e164: '+14155552671', isPrimary: true },
          { country: 'NP', e164: '+9779812345678', isPrimary: false },
        ],
        isPortalAdmin: false,
      },
    });
    // The refusal keeps both numbers.
    expect(posted('0.number')).toBe('+14155552671');
    expect(posted('1.number')).toBe('+9779812345678');
  });
});
