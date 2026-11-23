// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';

// The real transport is XMLHttpRequest; each test resolves the upload when it wants to.
const transport = vi.hoisted(() => ({
  calls: [] as {
    url: string;
    headers: Record<string, string>;
    progress: (fraction: number) => void;
    resolve: (answer: { status: number; body: unknown }) => void;
    reject: (err: unknown) => void;
  }[],
}));
vi.mock('./send-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./send-file')>();
  return {
    ...actual,
    sendFile: vi.fn(
      (
        url: string,
        _file: Blob,
        headers: Record<string, string>,
        progress: (fraction: number) => void,
      ) => {
        let resolve!: (answer: { status: number; body: unknown }) => void;
        let reject!: (err: unknown) => void;
        const done = new Promise<{ status: number; body: unknown }>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        transport.calls.push({ url, headers, progress, resolve, reject });
        return { done, abort: vi.fn(() => reject(new actual.SendInterrupted(true))) };
      },
    ),
  };
});

import { EvidenceUpload, type EvidenceUploadProps } from './evidence-upload';

const ORDER = '11111111-2222-4333-8444-555555555555';
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VERSION = 'ffffffff-0000-4111-8222-333333333333';

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;
let blocking: Mock<(blocking: boolean) => void>;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

function staged(status = 'quarantined') {
  return {
    documentId: DOC,
    versionId: VERSION,
    filename: 'Signed acceptance.pdf',
    sizeBytes: 2048,
    mimeType: 'application/pdf',
    status,
  };
}

beforeEach(() => {
  transport.calls = [];
  blocking = vi.fn();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function inForm(props: Partial<EvidenceUploadProps> = {}) {
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <EvidenceUpload
        kind="sales-order"
        ownerId={ORDER}
        name="otherDocumentId"
        label="Evidence document"
        onBlockingChange={blocking}
        {...props}
      />
    </form>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('No file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
  await settle();
}

async function answer(status: number, body: unknown) {
  const call = transport.calls.at(-1);
  if (!call) throw new Error('No upload in flight');
  await act(() => {
    call.resolve({ status, body });
    return Promise.resolve();
  });
  await settle();
}

function pdf(name = 'Signed acceptance.pdf', bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

const hidden = () =>
  document.querySelector<HTMLInputElement>('input[type="hidden"][name="otherDocumentId"]')!;
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
const removeButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Remove Signed acceptance.pdf"]');

describe('EvidenceUpload', () => {
  it('puts a muted "Optional" beside the label when optional, and nothing when not (UIP-FORM-008)', async () => {
    mounted = await mountForm(inForm({ optional: true, hint: 'Kept with the order.' }));
    const group = document.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.textContent).toContain('Evidence document');
    expect(group.textContent).toContain('Optional');
    // The marker is in the label row, not in the label (whose text names the group) or under the box.
    expect(group.getAttribute('aria-labelledby')).not.toBeNull();
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Evidence document',
    );
    await mounted.unmount();
    mounted = await mountForm(inForm());
    expect(document.querySelector('[role="group"]')?.textContent).not.toContain('Optional');
  });

  it('labels a keyboard-reachable file chooser and says which files it takes', async () => {
    mounted = await mountForm(inForm({ hint: 'The signed acceptance form.' }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.disabled).toBe(false);
    expect(input.accept).toContain('application/pdf');
    expect(document.getElementById(input.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Evidence document',
    );
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'The signed acceptance form.',
    );
    expect(document.body.textContent).toContain('PDF, PNG, JPEG, WebP, Word, Excel');
    expect(hidden().value).toBe('');
  });

  it('uploads to the record, shows progress, and blocks the form while the file is on the wire', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    const call = transport.calls[0]!;
    expect(call.url).toBe(`/api/evidence/sales-order/${ORDER}`);
    expect(call.headers).toEqual({
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent('Signed acceptance.pdf'),
    });
    expect(blocking).toHaveBeenLastCalledWith(true);
    expect(hidden().value).toBe('');
    await act(() => {
      call.progress(0.4);
      return Promise.resolve();
    });
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Uploading Signed acceptance.pdf',
    );
  });

  it('sets the hidden id after the upload and shows the file chip with its size and scan', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged());
    expect(hidden().value).toBe(DOC);
    expect(blocking).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.body.textContent).toContain('Signed acceptance.pdf');
    expect(document.body.textContent).toContain('2 KB');
    expect(document.body.textContent).toContain('Scanning');
    // A file still being scanned may be saved: the server decides.
    expect(blocking).not.toHaveBeenLastCalledWith(true);
    expect(removeButton()).not.toBeNull();
    // No document id is shown to the person.
    expect(document.body.textContent).not.toContain(DOC);
  });

  it('leaves focus where the person was typing while the file uploaded', async () => {
    mounted = await mountForm(
      <form onSubmit={(event) => event.preventDefault()}>
        <input aria-label="Reference" />
        <EvidenceUpload kind="rfq" ownerId={ORDER} name="otherDocumentId" label="Quotation" />
      </form>,
    );
    await choose(pdf());
    const other = document.querySelector<HTMLInputElement>('input[aria-label="Reference"]')!;
    other.focus();
    await answer(201, staged());
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(other);
  });

  it('moves focus to Remove when the upload was started from the control', async () => {
    mounted = await mountForm(inForm());
    document.querySelector<HTMLInputElement>('input[type="file"]')!.focus();
    await choose(pdf());
    await answer(201, staged());
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(removeButton());
  });

  // Through the record's own evidence route: the generic /api/documents removal needs
  // documents.upload, which the Accountant and Finance do not hold.
  it.each(['sales-order', 'vendor-bill', 'rfq'] as const)(
    'removing before save deletes the staged %s document through its record route',
    async (kind) => {
      mounted = await mountForm(inForm({ kind }));
      await choose(pdf());
      await answer(201, staged());
      await click(removeButton());
      expect(deletes().map(([url]) => url)).toEqual([`/api/evidence/${kind}/${ORDER}/${DOC}`]);
      expect(deletes()[0]![1]).toMatchObject({ method: 'DELETE', keepalive: true });
    },
  );

  it('removing before save clears the field and brings the drop zone back', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged());
    await click(removeButton());
    expect(deletes()).toHaveLength(1);
    expect(hidden().value).toBe('');
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('never deletes a file the form was submitted with, on remove or on unmount', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged());
    await submit(mounted.container);
    await mounted.unmount();
    mounted = undefined;
    expect(deletes()).toHaveLength(0);
  });

  it('drops an unsaved upload when the form goes away without a submit', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged());
    await mounted.unmount();
    mounted = undefined;
    expect(deletes().map(([url]) => url)).toEqual([`/api/evidence/sales-order/${ORDER}/${DOC}`]);
  });

  it('blocks an infected file and says so in the words every file form uses', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged('infected'));
    expect(blocking).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'A virus was found in this file. Remove it or upload a clean copy, then try again.',
    );
    expect(document.body.textContent).toContain('Virus found');
  });

  it('blocks a rejected file too', async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(201, staged('rejected'));
    expect(blocking).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/rejected/);
  });

  it('refuses an empty file or a type the platform does not take before sending anything', async () => {
    mounted = await mountForm(inForm());
    await choose(new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That file is empty.');
    await choose(new File(['x'], 'tool.exe', { type: 'application/x-msdownload' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/not accepted/);
    expect(transport.calls).toHaveLength(0);
    expect(document.querySelector('input[type="file"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it("shows the server's refusal, and a plain sentence when the connection drops", async () => {
    mounted = await mountForm(inForm());
    await choose(pdf());
    await answer(403, { error: { message: 'You cannot add files to this order.' } });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'You cannot add files to this order.',
    );
    expect(blocking).toHaveBeenLastCalledWith(false);
    await choose(pdf());
    await act(() => {
      transport.calls.at(-1)!.reject(new Error('network'));
      return Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/interrupted/);
    expect(hidden().value).toBe('');
  });

  it("marks the chooser invalid with the form's own error so the form can focus it", async () => {
    mounted = await mountForm(
      inForm({ error: 'Upload the document that shows this step was done.' }),
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Upload the document that shows this step was done.',
    );
  });
});
