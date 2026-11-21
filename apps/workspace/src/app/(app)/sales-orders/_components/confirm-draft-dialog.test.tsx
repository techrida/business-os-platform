// @vitest-environment jsdom
import { ErrorBodySchema, OpportunityDtoSchema } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

// The real confirm action runs behind the dialog: only the API, the session and the deal read are faked.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  getOpportunity: vi.fn(),
  getPermissionCheck: vi.fn(),
  overrideCreditHoldAction: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  getCreditHold: () => Promise.reject(new Error('403')),
}));
vi.mock('@/lib/live-permissions', () => ({ getPermissionCheck: mocks.getPermissionCheck }));
vi.mock('@/app/(app)/opportunities/actions', () => ({
  overrideCreditHoldAction: mocks.overrideCreditHoldAction,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { ConfirmDraftDialog } = await import('./confirm-draft-dialog');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERSION = '22222222-2222-4222-8222-222222222222';
const DEAL = '11111111-1111-4111-8111-111111111111';

/** `POST /v1/sales-orders` refusing a customer over its limit, as the API's error filter sends it. */
const creditHold = () =>
  Promise.resolve(
    new Response(
      JSON.stringify(
        ErrorBodySchema.parse({
          error: {
            code: 'credit_hold',
            message:
              'With the receivables, the orders not yet invoiced and this order, the customer is over its credit limit; someone with credit override access must override the credit hold on the deal first',
            correlationId: 'corr-1',
            details: { opportunityId: DEAL },
          },
        }),
      ),
      { status: 409 },
    ),
  );
/** The deal as `GET /v1/opportunities/:id` sends it, through the contract. */
const deal = OpportunityDtoSchema.parse({
  id: DEAL,
  number: 'DEAL-0042',
  name: 'Bridge works',
  customerId: '33333333-3333-4333-8333-333333333333',
  contactId: null,
  leadId: null,
  ownerUserId: null,
  ownerName: null,
  stage: 'won',
  stageReason: null,
  lostReason: null,
  stageNote: null,
  value: null,
  currency: 'NPR',
  probability: null,
  expectedClose: null,
  wonQuotationVersionId: VERSION,
  version: 1,
  creditHold: { held: true, overridden: false },
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
});
const grants = (...held: string[]) =>
  mocks.getPermissionCheck.mockResolvedValue((p: string) => held.includes(p));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.apiFetch.mockImplementation(creditHold);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};

async function confirmDraft() {
  const mounted = await mountForm(
    <ConfirmDraftDialog
      quotationVersionId={VERSION}
      idempotencyKey={KEY}
      reloadHref="/sales-orders/x"
    />,
  );
  await click(mounted.container.querySelector('button'));
  const form = document.querySelector('[role="dialog"] form');
  await act(() => Promise.resolve((form as HTMLFormElement | null)?.requestSubmit()));
  await settle();
  return mounted;
}

const HELD = /over its credit limit/;
const OVERRIDE = 'Override credit hold';
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const dialogLinks = () =>
  [...(dialogs()[0]?.querySelectorAll('a') ?? [])].map((a) => [
    a.textContent,
    a.getAttribute('href'),
  ]);
const sentKeys = () =>
  mocks.apiFetch.mock.calls.map(
    (c) =>
      ((c as [unknown, string, RequestInit])[2].headers as Record<string, string>)[
        'idempotency-key'
      ],
  );

it('lets a credit.override holder who cannot open the deal override it and confirm again (F1-Q20)', async () => {
  mocks.getOpportunity.mockRejectedValue(new Error('404'));
  grants('sales_order.confirm', 'credit.override');
  const mounted = await confirmDraft();

  // The draft form sends only its quotation version: no evidence ids.
  const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
  expect(path).toBe('/v1/sales-orders');
  expect(JSON.parse(init.body as string)).toEqual({
    quotationVersionId: VERSION,
    evidenceDocumentIds: [],
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(HELD);
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);

  mocks.overrideCreditHoldAction.mockResolvedValue({ ok: true });
  await click(buttonNamed(OVERRIDE));
  expect(dialogs()).toHaveLength(2);
  const override = dialogs().at(-1)!;
  const reason = override.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    reason,
    'Cheque received today.',
  );
  await act(() => Promise.resolve(reason.dispatchEvent(new Event('input', { bubbles: true }))));
  await click(
    [...override.querySelectorAll('button')].find((b) => b.textContent === 'Override hold') ?? null,
  );
  await settle();

  const sent = mocks.overrideCreditHoldAction.mock.calls[0]?.[1] as FormData;
  expect(sent.get('opportunityId')).toBe(DEAL);
  expect(sent.get('reason')).toBe('Cheque received today.');
  expect(mocks.success).toHaveBeenCalledWith('Credit hold overridden. Confirm the order again.');
  expect(dialogs()[0]?.querySelector('[role="status"]')?.textContent).toContain(
    'Credit hold overridden',
  );
  expect(buttonNamed(OVERRIDE)).toBeNull();

  // Confirm again from the same dialog: a new decision, so a new key reaches the API.
  const form = dialogs()[0]?.querySelector('form') as HTMLFormElement;
  await act(() => Promise.resolve(form.requestSubmit()));
  await settle();
  expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  const [first, second] = sentKeys();
  expect(first).toBe(KEY);
  expect(second).not.toBe(KEY);
  await mounted.unmount();
});

it('links to the deal for someone who can open it, with no Override they do not hold', async () => {
  mocks.getOpportunity.mockResolvedValue(deal);
  grants('sales_order.confirm');
  const mounted = await confirmDraft();
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(HELD);
  expect(dialogLinks()).toContainEqual(['Open DEAL-0042', `/opportunities/${DEAL}`]);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('leaves only the refusal for someone who can neither open nor override the deal', async () => {
  mocks.getOpportunity.mockRejectedValue(new Error('404'));
  grants('sales_order.confirm');
  const mounted = await confirmDraft();
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(HELD);
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});
