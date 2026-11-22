// @vitest-environment jsdom
import { CreditHoldDtoSchema, ErrorBodySchema, OpportunityDtoSchema } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

// The real confirm action runs behind the dialog: only the API, the session and the deal read are faked.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  getOpportunity: vi.fn(),
  getCreditHold: vi.fn(),
  getPermissionCheck: vi.fn(),
  overrideCreditHoldAction: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  success: vi.fn(),
  error: vi.fn(),
  uploads: [] as {
    url: string;
    resolve: (answer: { status: number; body: unknown }) => void;
  }[],
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  getCreditHold: mocks.getCreditHold,
}));
vi.mock('@/lib/display-settings', () => ({
  getNumberSystems: () => Promise.resolve(undefined),
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
// The browser upload is faked at the wire: each upload waits until the test answers it.
vi.mock('@/components/ui/send-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/send-file')>();
  return {
    ...actual,
    sendFile: vi.fn((url: string) => {
      let resolve!: (answer: { status: number; body: unknown }) => void;
      const done = new Promise<{ status: number; body: unknown }>((res) => {
        resolve = res;
      });
      mocks.uploads.push({ url, resolve });
      return { done, abort: vi.fn() };
    }),
  };
});

const { ConfirmDraftDialog } = await import('./confirm-draft-dialog');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERSION = '22222222-2222-4222-8222-222222222222';
const DEAL = '11111111-1111-4111-8111-111111111111';
const DOC = '44444444-4444-4444-8444-444444444444';
const FILE_VERSION = '55555555-5555-4555-8555-555555555555';

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

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
/** The deal's credit position as `GET /v1/opportunities/:id/credit-hold` sends it: the override needs its order value. */
const position = CreditHoldDtoSchema.parse({
  opportunityId: DEAL,
  customerId: '33333333-3333-4333-8333-333333333333',
  currency: 'NPR',
  creditLimit: '150000.00',
  exposure: '0.00',
  uninvoiced: '90400.00',
  orderValue: '90400.00',
  pendingQuotationVersionId: VERSION,
  exposureWithOrder: '180800.00',
  held: true,
  override: null,
  overrideCovers: false,
});
const grants = (...held: string[]) =>
  mocks.getPermissionCheck.mockResolvedValue((p: string) => held.includes(p));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.uploads = [];
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.apiFetch.mockImplementation(creditHold);
  mocks.getCreditHold.mockResolvedValue(position);
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

  // With no file uploaded, the draft form sends only its quotation version: no evidence ids.
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

// Evidence on the draft (R5 FU10 item 7): the same shared upload control as confirming from the list,
// filed against the draft's fixed quotation version.
async function openDraft() {
  const mounted = await mountForm(
    <ConfirmDraftDialog
      quotationVersionId={VERSION}
      idempotencyKey={KEY}
      reloadHref="/sales-orders/x"
    />,
  );
  await click(mounted.container.querySelector('button'));
  return mounted;
}

const draftDialog = () => document.querySelector('[role="dialog"]')!;
const fileInput = () => draftDialog().querySelector<HTMLInputElement>('input[type="file"]') ?? null;
const evidenceField = () =>
  draftDialog().querySelector<HTMLInputElement>('input[name="evidenceDocumentIds"]')!;
const submitButton = () => draftDialog().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
const FILE_URL = `/api/evidence/quotation-version/${VERSION}`;

async function chooseFile() {
  const input = fileInput();
  if (!input) throw new Error('No file input');
  const file = new File([new Uint8Array(512)], 'Purchase order.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
  await settle();
}

async function finishUpload() {
  await act(() => {
    mocks.uploads.at(-1)!.resolve({
      status: 201,
      body: {
        documentId: DOC,
        versionId: FILE_VERSION,
        filename: 'Purchase order.pdf',
        sizeBytes: 512,
        mimeType: 'application/pdf',
        status: 'quarantined',
      },
    });
    return Promise.resolve();
  });
  await settle();
}

async function submitDraft() {
  const form = draftDialog().querySelector<HTMLFormElement>('form');
  await act(() => Promise.resolve(form?.requestSubmit()));
  await settle();
}

it("uploads to the draft's quotation version, blocks Confirm while it uploads, then posts the one id", async () => {
  mocks.getOpportunity.mockRejectedValue(new Error('404'));
  grants('sales_order.confirm');
  const mounted = await openDraft();
  expect(draftDialog().textContent).toContain('Evidence document (optional)');
  expect(evidenceField().value).toBe('');
  expect(submitButton().disabled).toBe(false);

  await chooseFile();
  expect(mocks.uploads[0]!.url).toBe(FILE_URL);
  expect(submitButton().disabled).toBe(true);
  await finishUpload();
  expect(submitButton().disabled).toBe(false);
  expect(evidenceField().value).toBe(DOC);

  await submitDraft();
  const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
  expect(path).toBe('/v1/sales-orders');
  expect(JSON.parse(init.body as string)).toEqual({
    quotationVersionId: VERSION,
    evidenceDocumentIds: [DOC],
  });
  // Refused (credit hold): the file stays staged for the next try and is not deleted.
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(HELD);
  expect(evidenceField().value).toBe(DOC);
  expect(deletes()).toHaveLength(0);
  await mounted.unmount();
});

it('keeps nothing when the file is removed or the dialog is closed', async () => {
  const mounted = await openDraft();
  await chooseFile();
  await finishUpload();
  await click(draftDialog().querySelector('button[aria-label="Remove Purchase order.pdf"]'));
  await settle();
  expect(deletes().map(([url]) => url)).toEqual([`${FILE_URL}/${DOC}`]);
  expect(evidenceField().value).toBe('');

  await chooseFile();
  await finishUpload();
  expect(evidenceField().value).toBe(DOC);
  await click(buttonNamed('Cancel'));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(deletes().map(([url]) => url)).toEqual([`${FILE_URL}/${DOC}`, `${FILE_URL}/${DOC}`]);
  expect(mocks.apiFetch).not.toHaveBeenCalled();
  await mounted.unmount();
});

it('says the file was not filed when the order was already confirmed, never "Order confirmed" (R5 FU10 item 8)', async () => {
  mocks.apiFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          ErrorBodySchema.parse({
            error: {
              code: 'evidence_not_filed',
              message:
                'This order was already confirmed, so the named files were not filed with it',
              correlationId: 'corr-2',
            },
          }),
        ),
        { status: 409 },
      ),
    ),
  );
  const mounted = await openDraft();
  await chooseFile();
  await finishUpload();
  await submitDraft();

  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'This order was already confirmed, so your file was not filed with it.',
  );
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await mounted.unmount();
});
