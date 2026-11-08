'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { formatBytes, guessMime } from '@/lib/kernel-ui';

import { attachDocumentAction } from '../case-actions';
import styles from '../verification.module.css';

/** One checklist item the person can put a file on, worded by the server. */
export interface AttachOption {
  key: string;
  /** The option text: the item's name with whether it is required and where it stands. */
  text: string;
}

interface Problem {
  message: string;
  /** The page is out of date: offer a refresh that keeps the uploaded file. */
  reload: boolean;
}

interface Uploaded {
  documentId: string;
  /** What the file looked like when it went up, so a different pick is never attached by mistake. */
  name: string;
  size: number;
  lastModified: number;
}

type Phase = 'idle' | 'uploading' | 'attaching';

interface FieldErrors {
  item?: string | undefined;
  file?: string | undefined;
}

const sameFile = (u: Uploaded, f: File): boolean =>
  u.name === f.name && u.size === f.size && u.lastModified === f.lastModified;

/**
 * Put a file on one checklist item: upload it to the case, then attach it. The upload goes to the
 * case's own route (raw file as the body, its name in a header). Its document id is kept here, so
 * when the attach fails (a timeout, a stale page) the retry does not upload the file a second
 * time; picking another file drops it. The version and the Idempotency-Key come from the server
 * (the page, then each answer of the action), never from the browser.
 */
export function AttachForm({
  caseId,
  version,
  reopens,
  items,
  defaultKey,
  idempotencyKey,
  maxBytes,
  allowedMime,
}: {
  caseId: string;
  /** The case version this page was drawn from; the API refuses the attach if it moved on. */
  version: number;
  /** True on a rejected case: the attach sends it back to a draft. */
  reopens: boolean;
  items: AttachOption[];
  /** The item to preselect (the first required one without a file), or an empty string. */
  defaultKey: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  maxBytes: number;
  allowedMime: string[];
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [phase, setPhase] = useState<Phase>('idle');
  // `null` means "not touched": the default follows the page after each refresh.
  const [choice, setChoice] = useState<string | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [key, setKey] = useState(idempotencyKey);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<string | null>(null);

  const itemRef = useRef<HTMLSelectElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const busy = phase !== 'idle' || refreshing;
  const selected = choice ?? defaultKey;

  // A new problem object each time, so a repeated failure moves focus again.
  useEffect(() => {
    if (problem) summaryRef.current?.focus();
  }, [problem]);

  function refresh() {
    startRefresh(() => router.refresh());
  }

  async function upload(file: File, mime: string): Promise<string | null> {
    setPhase('uploading');
    try {
      // The raw file is the body (the browser adds Content-Length); its name travels in a header.
      const res = await fetch(`/verification/${encodeURIComponent(caseId)}/documents`, {
        method: 'POST',
        headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as {
        documentId?: string;
        error?: { message?: string };
      };
      if (res.status === 401) {
        // /auth/login is a Route Handler, not a page: it needs a real navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(`/verification/${caseId}`)}`;
        return null;
      }
      if (!res.ok || typeof data.documentId !== 'string') {
        setProblem({
          message: data.error?.message ?? 'The upload did not finish. Try again.',
          reload: false,
        });
        return null;
      }
      setUploaded({
        documentId: data.documentId,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      });
      return data.documentId;
    } catch {
      setProblem({
        message: 'The upload was interrupted. Check your connection and try again.',
        reload: false,
      });
      return null;
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const file = fileRef.current?.files?.[0];
    const errors: FieldErrors = {};
    if (!items.some((i) => i.key === selected)) errors.item = 'Choose which document this is.';
    const mime = file ? guessMime(file.name, file.type) : '';
    if (!file) errors.file = 'Choose a file to attach.';
    else if (file.size === 0) errors.file = 'That file is empty.';
    else if (file.size > maxBytes) {
      errors.file = `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`;
    } else if (!allowedMime.includes(mime)) {
      errors.file =
        'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.';
    }
    setFieldErrors(errors);
    setProblem(null);
    setDone(null);
    if (errors.item || errors.file || !file) {
      (errors.item ? itemRef : fileRef).current?.focus();
      return;
    }

    let documentId = uploaded !== null && sameFile(uploaded, file) ? uploaded.documentId : null;
    if (documentId === null) {
      documentId = await upload(file, mime);
      if (documentId === null) return setPhase('idle');
    }

    setPhase('attaching');
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('key', selected);
    form.set('documentId', documentId);
    form.set('expiresOn', expiresOn);
    form.set('expectedVersion', String(version));
    form.set('idempotencyKey', key);
    try {
      const res = await attachDocumentAction({ key }, form);
      setKey(res.key);
      if (res.error !== undefined) {
        if (res.reupload) setUploaded(null);
        setProblem({ message: res.error, reload: res.reload === true });
        return;
      }
      const item = items.find((i) => i.key === selected);
      setDone(
        `${file.name} is attached to ${res.attached ?? item?.text ?? 'the checklist'}.${
          reopens ? ' The case is a draft again, so you can submit it.' : ''
        }`,
      );
      setUploaded(null);
      setChoice(null);
      setExpiresOn('');
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    } catch {
      // The call may or may not have landed: the key stays, so the retry names the same request.
      setProblem({
        message:
          'We could not tell whether the document was attached. Try again; your file is already uploaded.',
        reload: false,
      });
    } finally {
      setPhase('idle');
    }
  }

  const label =
    phase === 'uploading' ? 'Uploading' : phase === 'attaching' ? 'Attaching' : 'Attach document';

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate className={styles.attach}>
      {reopens ? (
        <Alert tone="info">
          This case was rejected. Attaching a document reopens it as a draft, so you can fix it and
          submit it again.
        </Alert>
      ) : null}

      <div className={styles.attachFields}>
        <Field
          label="Document"
          hint="An item that already has a file takes the new one instead."
          error={fieldErrors.item}
        >
          {(control) => (
            <Select
              ref={itemRef}
              name="key"
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setChoice(e.target.value);
                setFieldErrors((f) => ({ ...f, item: undefined }));
              }}
              {...control}
            >
              <option value="" disabled>
                Choose a document
              </option>
              {items.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.text}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="File"
          hint={`PDF, image, Word, Excel, PowerPoint or CSV, up to ${formatBytes(maxBytes)}. Every file is scanned before anyone can open it.`}
          error={fieldErrors.file}
        >
          {(control) => (
            <input
              ref={fileRef}
              name="file"
              type="file"
              className={styles.fileInput}
              accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx,.csv"
              disabled={busy}
              onChange={() => {
                // A different file is a different upload.
                setUploaded(null);
                setFieldErrors((f) => ({ ...f, file: undefined }));
              }}
              {...control}
            />
          )}
        </Field>

        <Field label="Expiry date (optional)" hint="Leave empty if the document does not expire.">
          {(control) => (
            <Input
              name="expiresOn"
              type="date"
              value={expiresOn}
              disabled={busy}
              onChange={(e) => setExpiresOn(e.target.value)}
              {...control}
            />
          )}
        </Field>
      </div>

      {problem ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          actions={
            problem.reload ? (
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={refreshing}
                onClick={() => {
                  setProblem(null);
                  refresh();
                }}
              >
                Refresh this case
              </Button>
            ) : null
          }
        >
          {problem.message}
        </Alert>
      ) : null}

      {/* The region stays in the page, so a screen reader announces the text that arrives in it. */}
      <div aria-live="polite">{done !== null ? <Alert tone="success">{done}</Alert> : null}</div>

      <div className={styles.attachActions}>
        <Button type="submit" disabled={busy}>
          {label}
        </Button>
        {uploaded !== null && phase === 'idle' ? (
          <p className={styles.note}>
            {uploaded.name} is uploaded. Attach again to retry without uploading it a second time.
          </p>
        ) : null}
      </div>
      <p className={styles.status} role="status">
        {phase === 'uploading'
          ? 'Uploading the file'
          : phase === 'attaching'
            ? 'Attaching it to the checklist'
            : refreshing
              ? 'Updating the checklist'
              : ''}
      </p>
    </form>
  );
}
