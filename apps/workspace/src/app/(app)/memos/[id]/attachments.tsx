'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { previewKind } from '@/components/ui/file-preview-model';
import { toast } from '@/components/ui/toast';
import { type AttachmentView, formatBytes, needsPolling, scanLabel } from '@/lib/kernel-ui';

import styles from '../../kit.module.css';
import { PaperclipIcon, TrashIcon, UploadIcon } from '../memo-icons';
import {
  applyRemovedAttachment,
  applyUploadedAttachment,
  focusAfterAttachmentRemoval,
  hasDraggedFiles,
  performAttachmentRemoval,
  performAttachmentUpload,
  selectDroppedFile,
  type AttachmentFlightLock,
  type FocusTarget,
} from './attachment-actions';

const POLL_MS = 3000;
const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx,.csv';

const BADGE_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

function navigateToLogin(memoId: string): void {
  // /auth/login is a Route Handler, not a page: it needs a real navigation.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(`/memos/${memoId}`)}`);
}

const versionUrl = (f: AttachmentView, leaf: 'preview' | 'download') =>
  `/api/documents/${encodeURIComponent(f.documentId)}/versions/${encodeURIComponent(f.id)}/${leaf}`;

/**
 * Opens a scan-approved file in a dialog (UIP-FORM-003): PDFs and images are drawn, any other type shows the
 * dialog's "No preview" fallback. Download lives only inside the dialog, as its second action. A click cannot
 * show that the download succeeded, so the toast says it started.
 */
function OpenFile({ file }: { file: AttachmentView }) {
  const mimeType = file.detectedMime ?? 'application/octet-stream';
  const label = previewKind(mimeType) === 'unsupported' ? 'Open' : 'Preview';
  return (
    <FilePreviewDialog
      name={file.filename}
      mimeType={mimeType}
      previewUrl={versionUrl(file, 'preview')}
      downloadUrl={versionUrl(file, 'download')}
      onDownload={() => toast.info('Download started')}
      trigger={
        <Button variant="secondary" size="small" aria-label={`${label} ${file.filename}`}>
          <EyeIcon />
          {label}
        </Button>
      }
    />
  );
}

function EyeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * The attachments panel: list with scan status, instant upload (drop or picker), preview dialog, and
 * soft removal while the memo is editable. While any file is still being scanned it polls the BFF
 * every 3 s; when the last scan finishes it asks the server to re-render the page, so the Submit
 * button (a server-rendered part) unlocks without a manual reload. Serves the NFR "no unscanned
 * file is ever served": only `clean` files get a Download link.
 */
export function Attachments({
  memoId,
  initial,
  canUpload,
  maxBytes,
  allowedMime,
}: {
  memoId: string;
  initial: AttachmentView[];
  canUpload: boolean;
  maxBytes: number;
  allowedMime: string[];
}) {
  const router = useRouter();
  const hintId = useId();
  const [files, setFiles] = useState<AttachmentView[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [announce, setAnnounce] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingFocus = useRef<FocusTarget | null>(null);
  const flightLock = useRef<AttachmentFlightLock>({ busy: false });
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // A server re-render (after submit or save) brings fresh data: adopt it. Done while rendering,
  // the pattern React documents for "adjust state when a prop changes", not in an effect.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setFiles(initial);
  }

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target.type === 'upload') {
      uploadButtonRef.current?.focus();
    } else {
      removeButtonRefs.current.get(target.documentId)?.focus();
    }
  }, [files]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/memos/${encodeURIComponent(memoId)}/attachments`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: AttachmentView[] };
      const next = data.items ?? [];
      const before = new Map(filesRef.current.map((f) => [f.id, f.status]));
      const changed = next.filter((f) => before.has(f.id) && before.get(f.id) !== f.status);
      if (changed.length > 0) {
        setAnnounce(
          changed.map((f) => `${f.filename}: ${scanLabel(f.status).text.toLowerCase()}`).join('. '),
        );
      }
      setFiles(next);
      // The Submit button and its missing-pills are server-rendered in the page header: refresh whenever a
      // scan result changes, not only when the last one finishes.
      if (changed.length > 0 || !needsPolling(next.map((f) => f.status))) router.refresh();
    } catch {
      // The API is restarting or the network dropped: keep polling, the next tick may work.
    }
  }, [memoId, router]);

  const waiting = needsPolling(files.map((f) => f.status));
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, poll]);

  const busy = uploading || removingId !== null;

  async function startUpload(file: File) {
    const outcome = await performAttachmentUpload({
      lock: flightLock.current,
      memoId,
      file,
      maxBytes,
      allowedMime,
      onStart: () => setUploading(true),
    });
    if (outcome.kind === 'skipped') return;
    setUploading(false);

    if (outcome.kind === 'unauthenticated') {
      navigateToLogin(memoId);
      return;
    }
    if (outcome.kind === 'error') {
      toast.error('Upload failed', { description: outcome.message });
      return;
    }
    setFiles((prev) => applyUploadedAttachment(prev, outcome.item));
    toast.success('File uploaded', { description: `${outcome.item.filename} is being scanned.` });
    router.refresh();
  }

  async function handleRemove(item: AttachmentView, index: number) {
    const outcome = await performAttachmentRemoval({
      lock: flightLock.current,
      documentId: item.documentId,
      onStart: () => setRemovingId(item.documentId),
    });
    if (outcome.kind === 'skipped') return;
    setRemovingId(null);

    if (outcome.kind === 'unauthenticated') {
      navigateToLogin(memoId);
      return;
    }
    if (outcome.kind === 'error') {
      toast.error('Not removed', { description: outcome.message });
      if (outcome.reload) router.refresh();
      return;
    }
    const remaining = applyRemovedAttachment(filesRef.current, item.documentId);
    pendingFocus.current = focusAfterAttachmentRemoval(index, remaining);
    setFiles(remaining);
    toast.success('File removed', { description: item.filename });
    router.refresh();
  }

  function openPicker() {
    if (busy || flightLock.current.busy) return;
    inputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    // Reset immediately so choosing the same file again after upload, error, or removal still fires.
    e.currentTarget.value = '';
    if (!file) return;
    void startUpload(file);
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (!busy) setDragActive(true);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    if (!busy && !dragActive) setDragActive(true);
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (busy || flightLock.current.busy) return;
    if (!hasDraggedFiles(e.dataTransfer) && e.dataTransfer.files.length === 0) return;
    const picked = selectDroppedFile(e.dataTransfer.files);
    if (!picked.ok) {
      toast.error('Not attached', { description: picked.message });
      return;
    }
    void startUpload(picked.file);
  }

  function onDropzoneClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target instanceof Element && e.target.closest('button, input, a')) return;
    openPicker();
  }

  return (
    <div className={styles.attachments}>
      {files.length === 0 ? (
        <p className={styles.note}>No attachments yet.</p>
      ) : (
        <ul className={styles.files} aria-label="Attachments">
          {files.map((f, index) => {
            const scan = scanLabel(f.status);
            const removingThis = removingId === f.documentId;
            return (
              <li key={f.id} className={styles.file}>
                <span className={styles.fileIcon}>
                  <PaperclipIcon size={18} />
                </span>
                <div className={styles.fileText}>
                  <span className={styles.fileName}>{f.filename}</span>
                  <span className={styles.fileSize}>{formatBytes(f.sizeBytes)}</span>
                </div>
                <div className={styles.fileSide}>
                  <Badge tone={BADGE_TONE[scan.tone]}>{scan.text}</Badge>
                  {f.status === 'clean' ? <OpenFile file={f} /> : null}
                  {canUpload ? (
                    <button
                      ref={(el) => {
                        if (el) removeButtonRefs.current.set(f.documentId, el);
                        else removeButtonRefs.current.delete(f.documentId);
                      }}
                      type="button"
                      className={styles.removeAttachment}
                      aria-label={`Remove ${f.filename}`}
                      title={`Remove ${f.filename}`}
                      disabled={busy}
                      aria-busy={removingThis || undefined}
                      onClick={() => void handleRemove(f, index)}
                    >
                      <TrashIcon size={16} />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Scan results are announced here, not by re-reading the whole list. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {canUpload ? (
        <div className={styles.upload}>
          <input
            ref={inputRef}
            name="file"
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPTED_EXTENSIONS}
            disabled={busy}
            onChange={onFileChange}
          />
          <div
            className={[
              styles.dropzone,
              dragActive ? styles.dropzoneActive : undefined,
              busy ? styles.dropzoneDisabled : undefined,
            ]
              .filter(Boolean)
              .join(' ')}
            data-dragging={dragActive ? 'true' : undefined}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onDropzoneClick}
          >
            <div className={styles.dropzoneRow}>
              <Button
                ref={uploadButtonRef}
                type="button"
                variant="secondary"
                disabled={busy}
                aria-describedby={hintId}
                onClick={openPicker}
              >
                <UploadIcon />
                {uploading ? 'Uploading…' : 'Upload file'}
              </Button>
              <span className={styles.dropzonePrompt}>
                {dragActive
                  ? 'Drop the file to start uploading.'
                  : 'Or drag and drop a single file here.'}
              </span>
            </div>
            <p id={hintId} className={styles.dropzoneHint}>
              PDF, image, Word, Excel, PowerPoint or CSV, up to {formatBytes(maxBytes)}. Selecting
              or dropping a file starts the upload immediately, and every file is scanned before
              anyone can download it.
            </p>
          </div>
        </div>
      ) : (
        <p className={styles.note}>
          Files can only be added or removed while the memo is a draft or returned.
        </p>
      )}
    </div>
  );
}
