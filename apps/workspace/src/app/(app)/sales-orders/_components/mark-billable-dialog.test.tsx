// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { IDS } from '../_lib/fixtures';

const mocks = vi.hoisted(() => ({
  markBillableAction: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  uploads: [] as {
    url: string;
    resolve: (answer: { status: number; body: unknown }) => void;
  }[],
}));
vi.mock('../_lib/actions', () => ({ markBillableAction: mocks.markBillableAction }));
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

const { MarkBillableDialog } = await import('./mark-billable-dialog');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUIRED = 'Upload the document that shows this step was done.';

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.uploads = [];
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
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
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function open(evidence: { documentId: string; label: string }[] = []) {
  mounted = await mountForm(
    <MarkBillableDialog
      salesOrderId={IDS.order}
      scheduleLineId={IDS.milestone}
      lineLabel="Go-live"
      version={3}
      evidence={evidence}
      idempotencyKey={KEY}
      reloadHref={`/sales-orders/${IDS.order}`}
    />,
  );
  await click(mounted.container.querySelector('button'));
}

async function chooseFile() {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]');
  if (!input) throw new Error('No file input');
  const file = new File([new Uint8Array(512)], 'Acceptance.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
  await settle();
}

async function finishUpload(status = 'quarantined') {
  await act(() => {
    mocks.uploads.at(-1)!.resolve({
      status: 201,
      body: {
        documentId: DOC,
        versionId: VERSION,
        filename: 'Acceptance.pdf',
        sizeBytes: 512,
        mimeType: 'application/pdf',
        status,
      },
    });
    return Promise.resolve();
  });
  await settle();
}

const submitButton = () =>
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!;
const uploaded = () =>
  document.querySelector<HTMLInputElement>('[role="dialog"] input[name="otherDocumentId"]')!;
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');

async function submitDialog() {
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form');
  await act(() => Promise.resolve(form?.requestSubmit()));
  await settle();
}

describe('MarkBillableDialog', () => {
  it('offers only an upload when the order has no evidence: no id to type', async () => {
    await open();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('input[type="text"], input:not([type])')).toBeNull();
    expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
    expect(dialog.textContent).toContain('Evidence document');
    expect(dialog.textContent).not.toMatch(/document id/i);
  });

  it('keeps the evidence list and replaces only the typed id with an upload', async () => {
    await open([{ documentId: IDS.po, label: 'Customer PO …8881' }]);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('input[name="evidenceDocumentId"]')).not.toBeNull();
    expect(dialog.textContent).toContain('Or upload another document');
    expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
    expect(dialog.textContent).not.toMatch(/document id/i);
  });

  it('blocks Mark billable while the file uploads, then posts its id', async () => {
    mocks.markBillableAction.mockResolvedValue({ key: KEY, done: true });
    await open();
    expect(submitButton().disabled).toBe(false);
    await chooseFile();
    expect(mocks.uploads[0]!.url).toBe(`/api/evidence/sales-order/${IDS.order}`);
    expect(submitButton().disabled).toBe(true);
    await finishUpload();
    expect(submitButton().disabled).toBe(false);
    expect(uploaded().value).toBe(DOC);

    await submitDialog();
    const sent = mocks.markBillableAction.mock.calls[0]![1] as FormData;
    expect(sent.get('otherDocumentId')).toBe(DOC);
    // Saved: the dialog closed with the file bound to the line, so nothing is deleted.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it('keeps Mark billable off for an infected file', async () => {
    await open();
    await chooseFile();
    await finishUpload('infected');
    expect(submitButton().disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'A virus was found in this file.',
    );
  });

  it('shows the required-evidence message on the upload control', async () => {
    mocks.markBillableAction.mockResolvedValue({ key: KEY, errors: { document: REQUIRED } });
    await open();
    await submitDialog();
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(input.getAttribute('aria-describedby')!.split(' ').at(-1)!)
        ?.textContent,
    ).toBe(REQUIRED);
  });

  it('cancelling after an upload deletes the unsaved file', async () => {
    await open();
    await chooseFile();
    await finishUpload();
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent === 'Cancel',
    );
    await click(cancel ?? null);
    expect(deletes().map(([url]) => url)).toEqual([`/api/documents/${DOC}`]);
  });
});
