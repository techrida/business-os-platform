'use client';

import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@bos/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { guessMime } from '@/lib/kernel-ui';

import styles from '../payables.module.css';

/** Replaces the file on this draft's existing document, preserving the keyed bill. */
export function InvoiceReplacement({
  documentId,
  reloadHref,
}: {
  documentId: string;
  reloadHref: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [problem, setProblem] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (uploaded) resultRef.current?.focus();
  }, [uploaded]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setProblem('');
    if (!file || file.size === 0) {
      setProblem('Choose a non-empty replacement invoice file.');
      fileRef.current?.focus();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem('The replacement invoice must be at most 25 MB.');
      fileRef.current?.focus();
      return;
    }
    const mime = guessMime(file.name, file.type);
    if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
      setProblem('Choose a PDF, image, Office document or CSV invoice.');
      fileRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setUploading(true);
    try {
      const response = await fetch('/payables/bill-documents', {
        method: 'POST',
        headers: {
          'content-type': mime,
          'x-file-name': encodeURIComponent(file.name),
          'x-document-id': documentId,
        },
        body: file,
      });
      const data = (await response.json()) as { documentId?: string; versionId?: string };
      if (!response.ok || data.documentId !== documentId || typeof data.versionId !== 'string') {
        setProblem(
          response.status === 409
            ? 'The invoice can no longer be replaced. Reload the bill to check its current status.'
            : response.status === 403
              ? 'Your roles no longer allow invoice replacement. Reload the bill or ask an administrator.'
              : 'The replacement upload did not finish. Reload the bill to check its file before trying again.',
        );
        return;
      }
      setUploaded(true);
      toast.success('Replacement invoice uploaded');
    } catch {
      setProblem(
        'The replacement upload was interrupted. Reload the bill to check its file before trying again.',
      );
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  }

  if (uploaded)
    return (
      <Alert
        ref={resultRef}
        tabIndex={-1}
        tone="info"
        role="status"
        title="Check the scan status"
        actions={<a href={reloadHref}>Reload the bill</a>}
      >
        The new file must scan clean before this bill can be submitted. Reload the bill to check its
        scan status.
      </Alert>
    );

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void upload(event);
      }}
      className={styles.form}
      aria-busy={uploading}
    >
      <Field
        label="Replacement invoice file"
        hint="Up to 25 MB. This replaces the file on this draft bill; the invoice details and lines stay as keyed in."
        error={problem ? <span role="alert">{problem}</span> : undefined}
      >
        {(control) => (
          <Input
            {...control}
            ref={fileRef}
            type="file"
            accept={ALLOWED_MIME.join(',')}
            disabled={uploading}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setProblem('');
            }}
          />
        )}
      </Field>
      {problem ? (
        <p className={styles.note}>
          <a href={reloadHref}>Reload the bill</a> to check its current file and status.
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" disabled={uploading || !file}>
          {uploading ? 'Uploading replacement…' : 'Upload a replacement file'}
        </Button>
      </div>
      {uploading ? (
        <p role="status" className={styles.note}>
          Uploading the replacement invoice.
        </p>
      ) : null}
    </form>
  );
}
