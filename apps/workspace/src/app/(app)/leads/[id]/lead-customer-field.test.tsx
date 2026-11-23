// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const action = vi.hoisted(() => ({ unlinkLeadCustomerAction: vi.fn() }));
vi.mock('../actions', () => action);
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { LeadCustomerField } from './lead-customer-field';

const LEAD = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
});

const mount = (props: Partial<Parameters<typeof LeadCustomerField>[0]> = {}) =>
  mountForm(
    <LeadCustomerField
      leadId={LEAD}
      version={3}
      customerId={CUSTOMER}
      companyName="Himal Supplies Pvt. Ltd."
      editable
      {...props}
    />,
  );
const unlink = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Unlink customer') ?? null;

it('shows the link and an Unlink customer button for an editor, and sends the page version', async () => {
  action.unlinkLeadCustomerAction.mockResolvedValue({ ok: true, version: 4 });
  mounted = await mount();
  expect(document.querySelector('a')?.getAttribute('href')).toBe(`/customers/${CUSTOMER}`);
  await click(unlink());
  expect(action.unlinkLeadCustomerAction).toHaveBeenCalledWith(LEAD, 3);
});

it('says why when unlinking is refused', async () => {
  action.unlinkLeadCustomerAction.mockResolvedValue({
    ok: false,
    error: 'This record was changed by someone else.',
  });
  mounted = await mount();
  await click(unlink());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'changed by someone else',
  );
});

it('offers no button to a reader, and a lead without a link is just its name', async () => {
  mounted = await mount({ editable: false });
  expect(unlink()).toBeNull();
  await mounted.unmount();
  mounted = await mount({ customerId: null });
  expect(document.body.textContent).toContain('Himal Supplies Pvt. Ltd.');
  expect(document.querySelector('a')).toBeNull();
  expect(unlink()).toBeNull();
});
