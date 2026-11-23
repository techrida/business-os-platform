// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { act } from 'react';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

const action = vi.hoisted(() => ({ updateLeadAddressAction: vi.fn() }));
vi.mock('../actions', () => action);
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LeadAddressField } from './lead-address-field';

const LEAD = '11111111-1111-4111-8111-111111111111';
let mounted: Awaited<ReturnType<typeof mountForm>>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
});

/** `fill` only types into inputs; the street lines are a textarea. */
async function fillArea(area: Element | null, value: string) {
  if (!(area instanceof HTMLTextAreaElement)) throw new Error('Missing address box');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
  await act(() => Promise.resolve(area.dispatchEvent(new Event('input', { bubbles: true }))));
}

const mount = (props: Partial<Parameters<typeof LeadAddressField>[0]> = {}) =>
  mountForm(<LeadAddressField leadId={LEAD} version={4} address={null} editable {...props} />);

it('shows the saved address, or Not set, and offers the editor only to an editor', async () => {
  mounted = await mount({ address: { line: '12 Lazimpat Road', city: 'Kathmandu' } });
  expect(mounted.container.textContent).toContain('12 Lazimpat Road, Kathmandu');
  expect(mounted.container.textContent).toContain('Edit address');
  await mounted.unmount();
  mounted = await mount({ editable: false });
  expect(mounted.container.textContent).toContain('Not set');
  expect(mounted.container.textContent).not.toContain('Add address');
});

it('saves a new address with the version the page showed', async () => {
  action.updateLeadAddressAction.mockResolvedValue({ ok: true });
  mounted = await mount();
  await click(mounted.container.querySelector('button'));
  const form = mounted.container.querySelector('form')!;
  await fillArea(form.querySelector('textarea[name="address.line"]'), 'Ward 4, Lakeside');
  await fill(form.querySelector('input[name="address.city"]'), 'Pokhara');
  await submit(mounted.container);
  expect(action.updateLeadAddressAction).toHaveBeenCalledTimes(1);
  const posted = action.updateLeadAddressAction.mock.calls[0]?.[1] as FormData;
  expect(posted.get('address.line')).toBe('Ward 4, Lakeside');
  expect(posted.get('address.city')).toBe('Pokhara');
  expect(posted.get('leadId')).toBe(LEAD);
  expect(posted.get('expectedVersion')).toBe('4');
});

it('puts the refusal for half an address under the field it names', async () => {
  action.updateLeadAddressAction.mockResolvedValue({
    fieldErrors: {
      'address.city': 'Enter the city (up to 100 characters), or clear the address too.',
    },
  });
  mounted = await mount();
  await click(mounted.container.querySelector('button'));
  const form = mounted.container.querySelector('form')!;
  await fillArea(form.querySelector('textarea[name="address.line"]'), 'Ward 4');
  await submit(mounted.container);
  expect(form.textContent).toContain('Enter the city');
});

it('sends nothing when the address is left as it was', async () => {
  mounted = await mount({ address: { line: 'Ward 4', city: 'Pokhara' } });
  await click(mounted.container.querySelector('button'));
  await submit(mounted.container);
  expect(action.updateLeadAddressAction).not.toHaveBeenCalled();
});
