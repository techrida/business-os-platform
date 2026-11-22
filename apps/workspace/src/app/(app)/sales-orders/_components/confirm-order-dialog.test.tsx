// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

import { choose, click, mountForm } from '@/test/form-interactions';

import { confirmRefusalText } from '../_lib/confirm-refusal';
import type { ActionState } from '../_lib/state';

const mocks = vi.hoisted(() => ({
  confirmOrderAction: vi.fn(),
  overrideCreditHoldAction: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  uploads: [] as {
    url: string;
    resolve: (answer: { status: number; body: unknown }) => void;
  }[],
}));
vi.mock('../_lib/actions', () => ({ confirmOrderAction: mocks.confirmOrderAction }));
vi.mock('@/app/(app)/opportunities/actions', () => ({
  overrideCreditHoldAction: mocks.overrideCreditHoldAction,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
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

const { ConfirmOrderDialog } = await import('./confirm-order-dialog');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = '11111111-1111-4111-8111-111111111111';
const QUOTE_A = {
  versionId: '22222222-2222-4222-8222-222222222222',
  number: 'QT-1',
  label: 'QT-1 · Acme',
};
const QUOTE_B = {
  versionId: '33333333-3333-4333-8333-333333333333',
  number: 'QT-2',
  label: 'QT-2 · Bolt',
};
const DOC = '44444444-4444-4444-8444-444444444444';
const FILE_VERSION = '55555555-5555-4555-8555-555555555555';

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.uploads = [];
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal('fetch', fetchMock);
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

/** Opens the dialog, picks `pick` (quotation A by default) and submits; the action answers `answer`. */
async function confirmWith(answer: ActionState, pick = QUOTE_A) {
  mocks.confirmOrderAction.mockResolvedValue(answer);
  const mounted = await mountForm(
    <ConfirmOrderDialog
      options={[QUOTE_A, QUOTE_B]}
      idempotencyKey={KEY}
      reloadHref="/sales-orders"
    />,
  );
  await click(mounted.container.querySelector('button'));
  await choose(document.body, 'quotationVersionId', pick.label);
  const form = document.querySelector('[role="dialog"] form');
  await act(() => Promise.resolve((form as HTMLFormElement | null)?.requestSubmit()));
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
  return mounted;
}

const dialogLinks = () =>
  [...(document.querySelector('[role="dialog"]')?.querySelectorAll('a') ?? [])].map((a) => [
    a.textContent,
    a.getAttribute('href'),
  ]);

/** The position the action read for a `credit.override` holder: the override is given at its order value. */
const POSITION = { orderValue: '90400.00', rows: [] };
const HELD =
  'With its open receivables, its confirmed orders not yet invoiced and this order, this customer is over its credit limit, so the sales order is on hold.';
const OVERRIDE = 'Override credit hold';
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];

it('lets a credit.override holder who cannot open the deal override it in place (F1-Q20)', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: {
      opportunityId: DEAL,
      number: null,
      canOpen: false,
      canOverride: true,
      quotationVersionId: QUOTE_A.versionId,
      position: POSITION,
    },
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('over its credit limit');
  // No link to a deal this person would get a 404 on.
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);

  mocks.overrideCreditHoldAction.mockResolvedValue({ ok: true });
  await click(buttonNamed(OVERRIDE));
  expect(dialogs()).toHaveLength(2);
  const override = dialogs().at(-1)!;
  // Finance cannot read the deal's number, so the dialog names the quotation it applies to.
  expect(override.textContent).toContain('The deal of quotation QT-1 can then be confirmed');
  const reason = override.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    reason,
    'Cheque received today.',
  );
  await act(() => Promise.resolve(reason.dispatchEvent(new Event('input', { bubbles: true }))));
  await click(
    [...override.querySelectorAll('button')].find((b) => b.textContent === 'Override hold') ?? null,
  );
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());

  expect(mocks.overrideCreditHoldAction).toHaveBeenCalledOnce();
  const sent = mocks.overrideCreditHoldAction.mock.calls[0]?.[1] as FormData;
  expect(sent.get('opportunityId')).toBe(DEAL);
  expect(sent.get('reason')).toBe('Cheque received today.');
  // Overriding is its own form: it never re-sends the confirm.
  expect(mocks.confirmOrderAction).toHaveBeenCalledOnce();
  expect(mocks.success).toHaveBeenCalledWith('Credit hold overridden. Confirm the order again.');
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
    'Credit hold overridden',
  );
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('links to the deal for someone who can open it, with no Override they do not hold', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: {
      opportunityId: DEAL,
      number: 'DEAL-0042',
      canOpen: true,
      canOverride: false,
      quotationVersionId: QUOTE_A.versionId,
    },
  });
  expect(dialogLinks()).toContainEqual(['Open DEAL-0042', `/opportunities/${DEAL}`]);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('adds nothing for someone who can neither open nor override the deal', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: {
      opportunityId: DEAL,
      number: null,
      canOpen: false,
      canOverride: false,
      quotationVersionId: QUOTE_A.versionId,
    },
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('over its credit limit');
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('offers no deal help for any other refusal', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: 'The evidence this step needs is missing.',
  });
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it("offers no Override or link for quotation A once quotation B is selected, and A's again on A", async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: {
      opportunityId: DEAL,
      number: 'DEAL-0042',
      canOpen: true,
      canOverride: true,
      quotationVersionId: QUOTE_A.versionId,
      position: POSITION,
    },
  });
  expect(buttonNamed(OVERRIDE)).not.toBeNull();
  expect(dialogLinks()).toContainEqual(['Open DEAL-0042', `/opportunities/${DEAL}`]);

  // The refusal was about A's deal: with B selected, nothing here may release A's hold.
  await choose(document.body, 'quotationVersionId', QUOTE_B.label);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);

  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  mocks.overrideCreditHoldAction.mockResolvedValue({ ok: true });
  await click(buttonNamed(OVERRIDE));
  const override = dialogs().at(-1)!;
  expect(override.textContent).toContain(
    'The deal of quotation QT-1 (DEAL-0042) can then be confirmed',
  );
  const reason = override.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    reason,
    'Cheque received today.',
  );
  await act(() => Promise.resolve(reason.dispatchEvent(new Event('input', { bubbles: true }))));
  await click(
    [...override.querySelectorAll('button')].find((b) => b.textContent === 'Override hold') ?? null,
  );
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
  const sent = mocks.overrideCreditHoldAction.mock.calls[0]?.[1] as FormData;
  expect(sent.get('opportunityId')).toBe(DEAL);

  // Overridden stays overridden when the person looks at B and comes back to A.
  await choose(document.body, 'quotationVersionId', QUOTE_B.label);
  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
    'Credit hold overridden',
  );
  await mounted.unmount();
});

// Evidence: uploaded to the chosen quotation version in place, never typed as ids.

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function openDialog() {
  const mounted = await mountForm(
    <ConfirmOrderDialog
      options={[QUOTE_A, QUOTE_B]}
      idempotencyKey={KEY}
      reloadHref="/sales-orders"
    />,
  );
  await click(mounted.container.querySelector('button'));
  return mounted;
}

const confirmDialog = () => document.querySelector('[role="dialog"]')!;
const fileInput = () =>
  confirmDialog().querySelector<HTMLInputElement>('input[type="file"]') ?? null;
const evidenceField = () =>
  confirmDialog().querySelector<HTMLInputElement>('input[name="evidenceDocumentIds"]')!;
const submitButton = () =>
  confirmDialog().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');

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

async function submitConfirm() {
  const form = confirmDialog().querySelector<HTMLFormElement>('form');
  await act(() => Promise.resolve(form?.requestSubmit()));
  await settle();
}

it('asks for a quotation before it offers an upload, and has no ids to type', async () => {
  const mounted = await openDialog();
  expect(confirmDialog().querySelector('textarea')).toBeNull();
  expect(fileInput()).toBeNull();
  expect(confirmDialog().textContent).toContain(
    'Choose a quotation first, then upload its evidence.',
  );
  expect(confirmDialog().textContent).not.toMatch(/document id|one per line/i);
  expect(evidenceField().value).toBe('');

  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  expect(fileInput()).not.toBeNull();
  expect(confirmDialog().textContent).toContain('Evidence document (optional)');
  expect(confirmDialog().textContent).not.toContain('Choose a quotation first');
  expect(confirmDialog().querySelector('textarea')).toBeNull();
  await mounted.unmount();
});

it('uploads to the chosen quotation, blocks Confirm while it uploads, then posts the one id', async () => {
  mocks.confirmOrderAction.mockResolvedValue({
    key: KEY,
    error: HELD,
    creditHold: {
      opportunityId: DEAL,
      number: null,
      canOpen: false,
      canOverride: false,
      quotationVersionId: QUOTE_A.versionId,
    },
  });
  const mounted = await openDialog();
  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  expect(submitButton().disabled).toBe(false);
  await chooseFile();
  expect(mocks.uploads[0]!.url).toBe(`/api/evidence/quotation-version/${QUOTE_A.versionId}`);
  expect(submitButton().disabled).toBe(true);
  await finishUpload();
  expect(submitButton().disabled).toBe(false);
  expect(evidenceField().value).toBe(DOC);

  await submitConfirm();
  const sent = mocks.confirmOrderAction.mock.calls[0]![1] as FormData;
  expect(sent.get('quotationVersionId')).toBe(QUOTE_A.versionId);
  expect(sent.getAll('evidenceDocumentIds')).toEqual([DOC]);
  // Refused: the file stays staged for the next try and is not deleted.
  expect(confirmDialog().textContent).toContain('over its credit limit');
  expect(evidenceField().value).toBe(DOC);
  expect(deletes()).toHaveLength(0);
  await mounted.unmount();
});

it('drops the staged file when another quotation is chosen', async () => {
  const mounted = await openDialog();
  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  await chooseFile();
  await finishUpload();
  expect(evidenceField().value).toBe(DOC);

  await choose(document.body, 'quotationVersionId', QUOTE_B.label);
  await settle();
  expect(deletes().map(([url]) => url)).toEqual([
    `/api/evidence/quotation-version/${QUOTE_A.versionId}/${DOC}`,
  ]);
  expect(evidenceField().value).toBe('');
  await chooseFile();
  expect(mocks.uploads.at(-1)!.url).toBe(`/api/evidence/quotation-version/${QUOTE_B.versionId}`);
  await mounted.unmount();
});

it('shows the evidence refusal on the upload control', async () => {
  const INVALID = 'The uploaded document is not valid. Remove it and upload it again.';
  mocks.confirmOrderAction.mockResolvedValue({ key: KEY, errors: { evidence: INVALID } });
  const mounted = await openDialog();
  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  await submitConfirm();
  const input = fileInput()!;
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(
    document.getElementById(input.getAttribute('aria-describedby')!.split(' ').at(-1)!)
      ?.textContent,
  ).toBe(INVALID);
  await mounted.unmount();
});

it('says the file was not filed when the order was already confirmed, never "Order confirmed" (R5 FU10 item 8)', async () => {
  // The action answers the API's 409 with the shared refusal words, as `confirmOrderAction` does.
  const alreadyConfirmed = {
    status: 409,
    body: {
      error: {
        code: 'evidence_not_filed',
        message: 'This order was already confirmed, so the named files were not filed with it',
        correlationId: 'corr-2',
      },
    },
  };
  mocks.confirmOrderAction.mockImplementation(() =>
    Promise.resolve({ key: 'rotated-key-0001', error: confirmRefusalText(alreadyConfirmed) }),
  );
  const mounted = await openDialog();
  await choose(document.body, 'quotationVersionId', QUOTE_A.label);
  await chooseFile();
  await finishUpload();
  await submitConfirm();

  expect(confirmDialog().querySelector('[role="alert"]')?.textContent).toContain(
    'This order was already confirmed, so your file was not filed with it.',
  );
  expect(mocks.success).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await mounted.unmount();
});
