// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({
  requestExceptionAction: vi.fn(),
  uploads: [] as { url: string; resolve: (answer: { status: number; body: unknown }) => void }[],
}));
vi.mock('../actions', () => ({
  matchBillAction: vi.fn(),
  discardBillAction: vi.fn(),
  rejectSubmissionAction: vi.fn(),
  requestExceptionAction: mocks.requestExceptionAction,
  submitBillAction: vi.fn(),
  voidBillAction: vi.fn(),
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

const { ExceptionDialog } = await import('./bill-actions');

const BILL = '11111111-1111-4111-8111-111111111111';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.uploads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
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

async function openDialog() {
  mounted = await mountForm(
    <ExceptionDialog targetId={BILL} idempotencyKey={KEY} reloadHref="/payables" label="BILL-7" />,
  );
  await click(mounted.container.querySelector('button'));
}

async function chooseFile() {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
  const file = new File([new Uint8Array(64)], 'Price agreement.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
  await settle();
}

async function finish(status: string) {
  await act(() => {
    mocks.uploads.at(-1)!.resolve({
      status: 201,
      body: {
        documentId: DOC,
        versionId: KEY,
        filename: 'Price agreement.pdf',
        sizeBytes: 64,
        mimeType: 'application/pdf',
        status,
      },
    });
    return Promise.resolve();
  });
  await settle();
}

const sendButton = () =>
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!;

describe('ExceptionDialog', () => {
  it('takes an optional evidence upload for this bill instead of a pasted document id', async () => {
    await openDialog();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Evidence');
    expect(dialog.textContent).toContain('Optional');
    expect(dialog.textContent).not.toContain('(optional)');
    expect(dialog.textContent).not.toMatch(/document id/i);
    expect(dialog.querySelector('input[name="evidenceDocumentId"]')?.getAttribute('type')).toBe(
      'hidden',
    );
    expect(sendButton().disabled).toBe(false);
  });

  it('holds Send to Finance while the file uploads, then sends its id', async () => {
    await openDialog();
    await chooseFile();
    expect(mocks.uploads[0]!.url).toBe(`/api/evidence/vendor-bill/${BILL}`);
    expect(sendButton().disabled).toBe(true);
    await finish('quarantined');
    expect(sendButton().disabled).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('[role="dialog"] input[name="evidenceDocumentId"]')
        ?.value,
    ).toBe(DOC);
  });

  it('keeps Send to Finance off for an infected file', async () => {
    await openDialog();
    await chooseFile();
    await finish('infected');
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'A virus was found in this file.',
    );
  });
});
