import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AttachmentView } from '@/lib/kernel-ui';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  applyRemovedAttachment,
  applyUploadedAttachment,
  focusAfterAttachmentRemoval,
  hasDraggedFiles,
  performAttachmentRemoval,
  performAttachmentUpload,
  selectDroppedFile,
  validateAttachmentFile,
  type AttachmentFlightLock,
} from './attachment-actions';
import { Attachments } from './attachments';

const MEMO_ID = '11111111-1111-4111-8111-111111111111';
const DOC_A = '22222222-2222-4222-8222-222222222222';
const DOC_B = '33333333-3333-4333-8333-333333333333';
const VER_A = '44444444-4444-4444-8444-444444444444';
const VER_B = '55555555-5555-4555-8555-555555555555';

const cleanItem: AttachmentView = {
  id: VER_A,
  documentId: DOC_A,
  filename: 'quote.pdf',
  sizeBytes: 2048,
  status: 'clean',
};

const infectedItem: AttachmentView = {
  id: VER_B,
  documentId: DOC_B,
  filename: 'bad-payload.pdf',
  sizeBytes: 1024,
  status: 'infected',
};

function makeFile(name: string, type: string, size: number): File {
  const bytes = new Uint8Array(Math.min(size, 16));
  const file = new File([bytes], name, { type });
  if (size !== bytes.byteLength) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

describe('attachment validation and drop selection', () => {
  it('rejects empty, oversized, and disallowed files before upload', () => {
    expect(
      validateAttachmentFile(
        makeFile('empty.pdf', 'application/pdf', 0),
        MAX_UPLOAD_BYTES,
        ALLOWED_MIME,
      ),
    ).toEqual({ ok: false, message: 'That file is empty.' });

    expect(
      validateAttachmentFile(
        makeFile('huge.pdf', 'application/pdf', MAX_UPLOAD_BYTES + 1),
        MAX_UPLOAD_BYTES,
        ALLOWED_MIME,
      ),
    ).toMatchObject({ ok: false });

    expect(
      validateAttachmentFile(
        makeFile('script.exe', 'application/x-msdownload', 100),
        MAX_UPLOAD_BYTES,
        ALLOWED_MIME,
      ),
    ).toMatchObject({ ok: false });

    expect(
      validateAttachmentFile(
        makeFile('ledger.csv', 'application/vnd.ms-excel', 100),
        MAX_UPLOAD_BYTES,
        ALLOWED_MIME,
      ),
    ).toEqual({ ok: true, mime: 'text/csv' });
  });

  it('requires exactly one dropped file and detects dragged file payloads', () => {
    const f1 = makeFile('a.pdf', 'application/pdf', 100);
    const f2 = makeFile('b.pdf', 'application/pdf', 100);
    expect(selectDroppedFile([])).toEqual({ ok: false, message: 'Drop a single file to attach.' });
    expect(selectDroppedFile([f1, f2])).toEqual({
      ok: false,
      message: 'Attach one file at a time.',
    });
    expect(selectDroppedFile([f1])).toEqual({ ok: true, file: f1 });
    expect(hasDraggedFiles({ types: ['Files'] })).toBe(true);
    expect(hasDraggedFiles({ types: ['text/plain'] })).toBe(false);
  });
});

describe('immediate upload single-flight and repeated selection', () => {
  it('triggers upload once when concurrent drop/picker calls race while in flight', async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchFn = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const lock: AttachmentFlightLock = { busy: false };
    const file = makeFile('quote.pdf', 'application/pdf', 512);

    const first = performAttachmentUpload({
      lock,
      memoId: MEMO_ID,
      file,
      maxBytes: MAX_UPLOAD_BYTES,
      allowedMime: ALLOWED_MIME,
      fetchFn,
    });
    const second = performAttachmentUpload({
      lock,
      memoId: MEMO_ID,
      file,
      maxBytes: MAX_UPLOAD_BYTES,
      allowedMime: ALLOWED_MIME,
      fetchFn,
    });

    expect(await second).toEqual({ kind: 'skipped' });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch(Response.json({ item: { ...cleanItem, status: 'quarantined' } }, { status: 201 }));
    expect(await first).toEqual({
      kind: 'ok',
      item: { ...cleanItem, status: 'quarantined' },
    });

    // After completion, selecting the exact same file again works cleanly.
    fetchFn.mockResolvedValueOnce(
      Response.json({ item: { ...cleanItem, status: 'quarantined' } }, { status: 201 }),
    );
    const repeat = await performAttachmentUpload({
      lock,
      memoId: MEMO_ID,
      file,
      maxBytes: MAX_UPLOAD_BYTES,
      allowedMime: ALLOWED_MIME,
      fetchFn,
    });
    expect(repeat.kind).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('attachment removal', () => {
  it('leaves the UI attachment list unchanged when the API refuses removal', async () => {
    let uiFiles: AttachmentView[] = [cleanItem, infectedItem];
    const lock: AttachmentFlightLock = { busy: false };

    const fetch409 = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          { error: { message: 'This memo is already submitted.', reload: true } },
          { status: 409 },
        ),
      ),
    );
    const refused409 = await performAttachmentRemoval({
      lock,
      documentId: infectedItem.documentId,
      fetchFn: fetch409,
    });
    expect(refused409).toEqual({
      kind: 'error',
      message: 'This memo is already submitted.',
      reload: true,
    });
    if (refused409.kind === 'ok') {
      uiFiles = applyRemovedAttachment(uiFiles, refused409.documentId);
    }
    expect(uiFiles).toEqual([cleanItem, infectedItem]);

    const fetch403 = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ error: { message: 'Forbidden', reload: false } }, { status: 403 }),
      ),
    );
    const refused403 = await performAttachmentRemoval({
      lock,
      documentId: cleanItem.documentId,
      fetchFn: fetch403,
    });
    expect(refused403).toEqual({ kind: 'error', message: 'Forbidden', reload: false });
    expect(uiFiles).toEqual([cleanItem, infectedItem]);

    const fetch401 = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    expect(
      await performAttachmentRemoval({ lock, documentId: cleanItem.documentId, fetchFn: fetch401 }),
    ).toEqual({ kind: 'unauthenticated' });
    expect(uiFiles).toEqual([cleanItem, infectedItem]);
  });

  it('removes an attachment only after 204 success and computes focus target', async () => {
    let uiFiles: AttachmentView[] = [cleanItem, infectedItem];
    const lock: AttachmentFlightLock = { busy: false };
    const fetch204 = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    const outcome = await performAttachmentRemoval({
      lock,
      documentId: infectedItem.documentId,
      fetchFn: fetch204,
    });
    expect(outcome).toEqual({ kind: 'ok', documentId: infectedItem.documentId });
    expect(fetch204).toHaveBeenCalledWith(`/api/documents/${infectedItem.documentId}`, {
      method: 'DELETE',
    });

    if (outcome.kind === 'ok') {
      uiFiles = applyRemovedAttachment(uiFiles, outcome.documentId);
    }
    expect(uiFiles).toEqual([cleanItem]);
    expect(focusAfterAttachmentRemoval(1, uiFiles)).toEqual({
      type: 'remove',
      documentId: cleanItem.documentId,
    });
    expect(focusAfterAttachmentRemoval(0, [])).toEqual({ type: 'upload' });
    expect(applyUploadedAttachment(uiFiles, infectedItem)).toEqual([cleanItem, infectedItem]);
  });
});

describe('Attachments markup', () => {
  it('renders an instant upload trigger without a form and filename-specific remove buttons on editable memos', () => {
    const html = renderToStaticMarkup(
      <Attachments
        memoId={MEMO_ID}
        initial={[cleanItem, infectedItem]}
        canUpload={true}
        maxBytes={MAX_UPLOAD_BYTES}
        allowedMime={[...ALLOWED_MIME]}
      />,
    );
    expect(html).not.toContain('<form');
    expect(html).toContain('Upload file');
    expect(html).toContain('aria-label="Remove quote.pdf"');
    expect(html).toContain('aria-label="Remove bad-payload.pdf"');
    expect(html).toContain('aria-label="Download quote.pdf"');
    expect(html).not.toContain('aria-label="Download bad-payload.pdf"');
  });

  it('hides upload and remove controls when the memo is no longer editable', () => {
    const html = renderToStaticMarkup(
      <Attachments
        memoId={MEMO_ID}
        initial={[cleanItem]}
        canUpload={false}
        maxBytes={MAX_UPLOAD_BYTES}
        allowedMime={[...ALLOWED_MIME]}
      />,
    );
    expect(html).not.toContain('Upload file');
    expect(html).not.toContain('aria-label="Remove quote.pdf"');
    expect(html).toContain(
      'Files can only be added or removed while the memo is a draft or returned.',
    );
  });
});
