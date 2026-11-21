// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({
  uploads: [] as { url: string; resolve: (answer: { status: number; body: unknown }) => void }[],
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

const { QuoteForm } = await import('./quote-form');

const RFQ = '11111111-1111-4111-8111-111111111111';
const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

async function mountRecord() {
  mounted = await mountForm(
    <QuoteForm
      action={vi.fn()}
      idempotencyKey="key"
      rfqId={RFQ}
      mode="record"
      vendors={[{ id: 'vendor', name: 'Vendor' }]}
      prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '1' }]}
      taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
      enabledCurrencies={['NPR']}
      cancelHref={`/procurement/rfqs/${RFQ}`}
      reloadHref={`/procurement/rfqs/${RFQ}/quotations/new`}
    />,
  );
}

const submitButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const documentField = () =>
  document.querySelector<HTMLInputElement>('input[type="hidden"][name="documentId"]')!;

describe('recording a quotation with its document', () => {
  it('uploads the vendor’s file to the RFQ, holds Record quotation meanwhile, then posts its id', async () => {
    await mountRecord();
    expect(document.body.textContent).toContain('Quotation document');
    expect(document.body.textContent).not.toMatch(/id of the vendor/i);
    expect(submitButton().disabled).toBe(false);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array(32)], 'Quote 118.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return Promise.resolve();
    });
    await settle();
    expect(mocks.uploads[0]!.url).toBe(`/api/evidence/rfq/${RFQ}`);
    expect(submitButton().disabled).toBe(true);
    expect(documentField().value).toBe('');

    await act(() => {
      mocks.uploads[0]!.resolve({
        status: 201,
        body: {
          documentId: DOC,
          versionId: VERSION,
          filename: 'Quote 118.pdf',
          sizeBytes: 32,
          mimeType: 'application/pdf',
          status: 'quarantined',
        },
      });
      return Promise.resolve();
    });
    await settle();
    expect(submitButton().disabled).toBe(false);
    expect(documentField().value).toBe(DOC);
  });
});
