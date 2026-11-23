'use client';

import { useRef, useState } from 'react';

import { Field, Input } from '@/components/portal/field';
import { Button } from '@/components/ui/button';

import { fileProblem, UPLOAD_ACCEPT } from './rules';
import styles from './upload.module.css';

interface Uploaded {
  documentId: string;
  filename: string;
}

/**
 * One file for a vendor form. A Client Component so the file uploads as soon as it is chosen (to
 * the portal's own upload route, never to the API directly: the browser has no token or API
 * address). The parent gets the document id once the upload is done, `null` when the file is
 * removed, and whether an upload is running so it can hold its Submit button. Choosing another
 * file replaces the first; the earlier upload is simply never submitted.
 */
export function FileUpload({
  endpoint,
  label,
  optional,
  hint,
  error,
  onDocument,
  onBusy,
}: {
  /** The portal route that receives the raw file, for example `/vendor/bills/new/file`. */
  endpoint: string;
  label: string;
  /** A file that may be left out: the Field shows the muted Optional beside the label. */
  optional?: boolean | undefined;
  hint: string;
  error?: string | undefined;
  onDocument: (documentId: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  function setUploading(value: boolean) {
    setBusy(value);
    onBusy(value);
  }

  async function choose(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setProblem(null);
    setUploaded(null);
    onDocument(null);
    const refusal = fileProblem(file);
    if (refusal !== null) {
      setProblem(refusal);
      if (pickerRef.current) pickerRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const body = (await res.json().catch(() => null)) as {
        documentId?: string;
        error?: string;
      } | null;
      if (res.ok && typeof body?.documentId === 'string') {
        setUploaded({ documentId: body.documentId, filename: file.name });
        onDocument(body.documentId);
      } else {
        setProblem(`${file.name}: ${body?.error ?? 'the upload failed. Try again.'}`);
      }
    } catch {
      setProblem(`${file.name}: the upload failed. Check your connection and try again.`);
    } finally {
      setUploading(false);
      // Allow choosing the same file again after a failure or a removal.
      if (pickerRef.current) pickerRef.current.value = '';
    }
  }

  function remove() {
    setUploaded(null);
    setProblem(null);
    onDocument(null);
  }

  return (
    <div className={styles.upload}>
      <Field label={label} optional={optional === true} hint={hint} error={error}>
        {(control) => (
          <Input
            ref={pickerRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            disabled={busy}
            onChange={(e) => void choose(e.target.files)}
            {...control}
          />
        )}
      </Field>
      <p className={styles.status} role="status">
        {busy ? 'Uploading the file…' : ''}
      </p>
      {problem ? (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      ) : null}
      {uploaded ? (
        <ul className={styles.files} aria-label="Uploaded file">
          <li>
            <span>{uploaded.filename}</span>
            <Button
              type="button"
              variant="ghost"
              size="small"
              aria-label={`Remove ${uploaded.filename}`}
              onClick={remove}
            >
              Remove
            </Button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
