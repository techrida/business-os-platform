'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import {
  type AttachmentView,
  formatBytes,
  guessMime,
  needsPolling,
  scanLabel,
} from '@/lib/kernel-ui';

import styles from '../../kit.module.css';
import { DownloadIcon, PaperclipIcon, UploadIcon } from '../memo-icons';

const POLL_MS = 3000;

type Message = { tone: 'ok' | 'bad'; text: string } | null;

const BADGE_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

/**
 * The attachments panel: list with scan status, upload, download. While any file is still being
 * scanned it polls the BFF every 3 s; when the last scan finishes it asks the server to re-render
 * the page, so the Submit button (a server-rendered part) unlocks without a manual reload.
 * Serves the NFR "no unscanned file is ever served": only `clean` files get a Download link.
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
  const [files, setFiles] = useState<AttachmentView[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
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
      if (!needsPolling(next.map((f) => f.status))) router.refresh();
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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setMessage({ tone: 'bad', text: 'Choose a file to attach first.' });
      inputRef.current?.focus();
      return;
    }
    if (file.size === 0) return setMessage({ tone: 'bad', text: 'That file is empty.' });
    if (file.size > maxBytes) {
      return setMessage({
        tone: 'bad',
        text: `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`,
      });
    }
    const mime = guessMime(file.name, file.type);
    if (!allowedMime.includes(mime)) {
      return setMessage({
        tone: 'bad',
        text: 'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.',
      });
    }

    setUploading(true);
    setMessage(null);
    try {
      // The raw file is the body (the browser adds Content-Length); its name travels in a header.
      const res = await fetch(`/api/memos/${encodeURIComponent(memoId)}/attachments`, {
        method: 'POST',
        headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as {
        item?: AttachmentView;
        error?: { message?: string };
      };
      if (res.status === 401) {
        // /auth/login is a Route Handler, not a page: it needs a real navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(`/memos/${memoId}`)}`;
        return;
      }
      if (!res.ok || !data.item) {
        setMessage({
          tone: 'bad',
          text: data.error?.message ?? 'The upload did not finish. Try again.',
        });
        return;
      }
      const item = data.item;
      setFiles((prev) => [...prev.filter((f) => f.id !== item.id), item]);
      setMessage({
        tone: 'ok',
        text: `${item.filename} uploaded. It is being scanned for viruses.`,
      });
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch {
      setMessage({
        tone: 'bad',
        text: 'The upload was interrupted. Check your connection and try again.',
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={styles.attachments}>
      {files.length === 0 ? (
        <p className={styles.note}>No attachments yet.</p>
      ) : (
        <ul className={styles.files} aria-label="Attachments">
          {files.map((f) => {
            const scan = scanLabel(f.status);
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
                  {f.status === 'clean' ? (
                    <LinkButton
                      variant="secondary"
                      size="small"
                      href={`/api/documents/${encodeURIComponent(f.documentId)}/versions/${encodeURIComponent(f.id)}/download`}
                      aria-label={`Download ${f.filename}`}
                    >
                      <DownloadIcon />
                      Download
                    </LinkButton>
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
        <form onSubmit={(e) => void onSubmit(e)} noValidate className={styles.upload}>
          <div className={styles.dropzone}>
            <Field
              label="Attach a file"
              hint={`PDF, image, Word, Excel, PowerPoint or CSV, up to ${formatBytes(maxBytes)}. Every file is scanned before anyone can download it.`}
            >
              {(control) => (
                <input
                  ref={inputRef}
                  name="file"
                  type="file"
                  className={styles.fileInput}
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx,.csv"
                  disabled={uploading}
                  {...control}
                />
              )}
            </Field>
          </div>
          <div className={styles.formActions}>
            <Button type="submit" variant="secondary" disabled={uploading}>
              <UploadIcon />
              {uploading ? 'Uploading' : 'Upload'}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.note}>
          Files can only be added while the memo is a draft or returned.
        </p>
      )}

      <div aria-live="polite">
        {message ? (
          <Alert tone={message.tone === 'ok' ? 'success' : 'error'}>{message.text}</Alert>
        ) : null}
      </div>
    </div>
  );
}
