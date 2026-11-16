import { type AttachmentView, formatBytes, guessMime } from '@/lib/kernel-ui';

export type AttachmentMessage = { tone: 'ok' | 'bad'; text: string } | null;

export interface AttachmentFileLike {
  name: string;
  size: number;
  type: string;
}

export interface AttachmentFlightLock {
  busy: boolean;
}

export type UploadOutcome =
  | { kind: 'ok'; item: AttachmentView }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string };

export type RemoveOutcome =
  | { kind: 'ok'; documentId: string }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string; reload: boolean };

export type FocusTarget = { type: 'remove'; documentId: string } | { type: 'upload' };

const UNSUPPORTED_TYPE_MESSAGE =
  'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.';

export function validateAttachmentFile(
  file: AttachmentFileLike,
  maxBytes: number,
  allowedMime: readonly string[],
): { ok: true; mime: string } | { ok: false; message: string } {
  if (file.size === 0) return { ok: false, message: 'That file is empty.' };
  if (file.size > maxBytes) {
    return {
      ok: false,
      message: `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`,
    };
  }
  const mime = guessMime(file.name, file.type);
  if (!allowedMime.includes(mime)) return { ok: false, message: UNSUPPORTED_TYPE_MESSAGE };
  return { ok: true, mime };
}

export function selectDroppedFile<T extends AttachmentFileLike>(
  files: ArrayLike<T> | null | undefined,
): { ok: true; file: T } | { ok: false; message: string } {
  if (!files || files.length === 0) {
    return { ok: false, message: 'Drop a single file to attach.' };
  }
  if (files.length > 1) {
    return { ok: false, message: 'Attach one file at a time.' };
  }
  return { ok: true, file: files[0]! };
}

export function hasDraggedFiles(
  dataTransfer: { types?: ArrayLike<string> } | null | undefined,
): boolean {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

export function applyUploadedAttachment(
  files: readonly AttachmentView[],
  item: AttachmentView,
): AttachmentView[] {
  return [...files.filter((f) => f.id !== item.id), item];
}

export function applyRemovedAttachment(
  files: readonly AttachmentView[],
  documentId: string,
): AttachmentView[] {
  return files.filter((f) => f.documentId !== documentId);
}

export function focusAfterAttachmentRemoval(
  removedIndex: number,
  remaining: readonly AttachmentView[],
): FocusTarget {
  if (remaining.length === 0) return { type: 'upload' };
  const target = remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)];
  return target ? { type: 'remove', documentId: target.documentId } : { type: 'upload' };
}

async function sendAttachmentUpload(opts: {
  memoId: string;
  file: AttachmentFileLike & BodyInit;
  mime: string;
  fetchFn?: typeof fetch;
}): Promise<UploadOutcome> {
  const fetcher = opts.fetchFn ?? fetch;
  try {
    // The raw file is the body (the browser adds Content-Length); its name travels in a header.
    const res = await fetcher(`/api/memos/${encodeURIComponent(opts.memoId)}/attachments`, {
      method: 'POST',
      headers: { 'content-type': opts.mime, 'x-file-name': encodeURIComponent(opts.file.name) },
      body: opts.file,
    });
    if (res.status === 401) return { kind: 'unauthenticated' };
    const data = (await res.json().catch(() => ({}))) as {
      item?: AttachmentView;
      error?: { message?: string };
    };
    if (!res.ok || !data.item) {
      return {
        kind: 'error',
        message: data.error?.message ?? 'The upload did not finish. Try again.',
      };
    }
    return { kind: 'ok', item: data.item };
  } catch {
    return {
      kind: 'error',
      message: 'The upload was interrupted. Check your connection and try again.',
    };
  }
}

export async function performAttachmentUpload(opts: {
  lock: AttachmentFlightLock;
  memoId: string;
  file: AttachmentFileLike & BodyInit;
  maxBytes: number;
  allowedMime: readonly string[];
  fetchFn?: typeof fetch;
  onStart?: () => void;
}): Promise<UploadOutcome | { kind: 'skipped' }> {
  if (opts.lock.busy) return { kind: 'skipped' };
  const checked = validateAttachmentFile(opts.file, opts.maxBytes, opts.allowedMime);
  if (!checked.ok) return { kind: 'error', message: checked.message };

  opts.lock.busy = true;
  opts.onStart?.();
  try {
    return await sendAttachmentUpload({
      memoId: opts.memoId,
      file: opts.file,
      mime: checked.mime,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
  } finally {
    opts.lock.busy = false;
  }
}

async function sendAttachmentRemoval(opts: {
  documentId: string;
  fetchFn?: typeof fetch;
}): Promise<RemoveOutcome> {
  const fetcher = opts.fetchFn ?? fetch;
  try {
    const res = await fetcher(`/api/documents/${encodeURIComponent(opts.documentId)}`, {
      method: 'DELETE',
    });
    if (res.status === 401) return { kind: 'unauthenticated' };
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; reload?: boolean };
      };
      return {
        kind: 'error',
        message: data.error?.message ?? 'Could not remove that attachment. Try again.',
        reload: Boolean(data.error?.reload),
      };
    }
    return { kind: 'ok', documentId: opts.documentId };
  } catch {
    return {
      kind: 'error',
      message: 'The removal was interrupted. Check your connection and try again.',
      reload: false,
    };
  }
}

export async function performAttachmentRemoval(opts: {
  lock: AttachmentFlightLock;
  documentId: string;
  fetchFn?: typeof fetch;
  onStart?: () => void;
}): Promise<RemoveOutcome | { kind: 'skipped' }> {
  if (opts.lock.busy) return { kind: 'skipped' };
  opts.lock.busy = true;
  opts.onStart?.();
  try {
    return await sendAttachmentRemoval({
      documentId: opts.documentId,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
  } finally {
    opts.lock.busy = false;
  }
}
