'use client';

// The evidence file a form needs (a billable step's proof, a match exception's support, a vendor's
// quotation), uploaded in place: drop a file or choose one, watch it upload, see its name, size and
// virus scan, and remove it before saving. The file is owned by the record the form acts on
// (`/api/evidence/:kind/:ownerId`), and the form posts its document id in a hidden field.

import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@bos/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { FileView } from '@/components/p2/crm/verification-file';
import { evidenceEndpoint, type EvidenceKind } from '@/lib/evidence';
import { INFECTED_FILE } from '@/lib/infected-file';
import { formatBytes, guessMime, scanLabel } from '@/lib/kernel-ui';

import { Badge } from './badge';
import { Button } from './button';
import { Icon } from './icon';
import { SendInterrupted, sendFile, type SendingFile } from './send-file';
import { useDocumentScan } from './use-document-scan';
import styles from './evidence-upload.module.css';

const ACCEPT = ALLOWED_MIME.join(',');
const FILE_TYPES = 'PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV';
const UPLOAD_FAILED = 'The upload did not finish. Try again.';
const OFFLINE = 'The upload was interrupted. Check your connection and try again.';
const REJECTED = 'This file was rejected. Remove it and upload another.';
const SCAN_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

export interface EvidenceUploadProps {
  /** The kind of record the evidence belongs to. */
  kind: EvidenceKind;
  /** The record's id: the uploaded file is owned by it. */
  ownerId: string;
  /** The name of the hidden field that carries the uploaded document id. */
  name: string;
  /** What the file is, for example "Evidence document". */
  label: string;
  /** May be left empty: a muted "Optional" at the right end of the label row (UIP-FORM-008), same as `Field`. */
  optional?: boolean | undefined;
  hint?: ReactNode | undefined;
  /** The form's own refusal for this field. */
  error?: string | undefined;
  /**
   * Told whether the form must wait: true while a file uploads or when the file is infected or
   * rejected. A file still being scanned does not block (the server decides on save).
   */
  onBlockingChange?: ((blocking: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  /** For placing the control in a form grid, such as a full-width cell. */
  className?: string | undefined;
}

/**
 * Deletes an upload that no saved record uses, through the record's own evidence route (its
 * permission, not `documents.upload`, which the Accountant and Finance do not hold). The API removes
 * only the uploader's own file, and only while the record has not taken it.
 */
function discard(endpoint: string, documentId: string) {
  void fetch(`${endpoint}/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {});
}

function refusalOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  const error = body.error;
  if (!error || typeof error !== 'object' || !('message' in error)) return undefined;
  return typeof error.message === 'string' && error.message.trim() ? error.message : undefined;
}

function isFileView(body: unknown): body is FileView {
  if (!body || typeof body !== 'object') return false;
  const v = body as Record<string, unknown>;
  return (
    typeof v['documentId'] === 'string' &&
    typeof v['versionId'] === 'string' &&
    typeof v['filename'] === 'string' &&
    typeof v['sizeBytes'] === 'number' &&
    typeof v['status'] === 'string'
  );
}

/**
 * @example
 *   <EvidenceUpload kind="vendor-bill" ownerId={bill.id} name="evidenceDocumentId"
 *     label="Evidence" optional error={errors.evidenceDocumentId} onBlockingChange={setBlocked} />
 */
export function EvidenceUpload({
  kind,
  ownerId,
  name,
  label,
  optional = false,
  hint,
  error,
  onBlockingChange,
  disabled = false,
  className,
}: EvidenceUploadProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const hintId = `${ids}-hint`;
  const problemId = `${ids}-problem`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const endpoint = evidenceEndpoint(kind, ownerId);

  const [staged, setStaged] = useState<FileView | null>(null);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const scan = useDocumentScan(endpoint, staged, staged !== null);
  const file = staged === null ? null : scan.file;

  // What unmounting must know without re-running effects: the staged id, whether a submit may have
  // used it, and an upload still on the wire.
  const stagedIdRef = useRef<string | null>(null);
  /** The record route the staged file was uploaded through: the one that removes it. */
  const stagedEndpointRef = useRef(endpoint);
  const submittedRef = useRef(false);
  const sendingRef = useRef<SendingFile | null>(null);
  const onBlockingRef = useRef(onBlockingChange);
  useEffect(() => {
    onBlockingRef.current = onBlockingChange;
  });
  useEffect(() => {
    stagedIdRef.current = staged?.documentId ?? null;
  }, [staged]);

  // Once the form is submitted with this file, the record may hold it: it is never deleted after
  // that, only cleared from the form (an unused file is left over rather than evidence lost).
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const onSubmit = () => {
      if (stagedIdRef.current !== null) submittedRef.current = true;
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, []);

  // Closing the dialog or leaving the page without saving drops the unsaved upload.
  useEffect(
    () => () => {
      sendingRef.current?.abort();
      const id = stagedIdRef.current;
      if (id !== null && !submittedRef.current) discard(stagedEndpointRef.current, id);
      // The form outlives this control (a dialog keeps its trigger): it must not stay blocked.
      onBlockingRef.current?.(false);
    },
    [],
  );

  const uploading = progress !== null;
  const status = file?.status;
  const badFile = status === 'infected' || status === 'rejected';
  const blocking = uploading || badFile;
  useEffect(() => {
    onBlockingRef.current?.(blocking);
  }, [blocking]);

  const editable = !disabled && !uploading;

  async function upload(selected: File) {
    if (!editable || staged !== null || sendingRef.current !== null) return;
    const mime = guessMime(selected.name, selected.type);
    if (selected.size === 0) return setProblem('That file is empty.');
    if (selected.size > MAX_UPLOAD_BYTES) {
      return setProblem(`That file is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    }
    if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
      return setProblem(`That file type is not accepted. Use ${FILE_TYPES}.`);
    }
    setProblem(null);
    setProgress({ name: selected.name, fraction: 0 });
    const sending = sendFile(
      endpoint,
      selected,
      { 'content-type': mime, 'x-file-name': encodeURIComponent(selected.name) },
      (fraction) => setProgress({ name: selected.name, fraction }),
    );
    sendingRef.current = sending;
    try {
      const answer = await sending.done;
      if (answer.status === 401) {
        const here = `${window.location.pathname}${window.location.search}`;
        // The login endpoint is a Route Handler and needs a document navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(here)}`;
        return;
      }
      if (answer.status !== 201 || !isFileView(answer.body)) {
        setProblem(refusalOf(answer.body) ?? UPLOAD_FAILED);
        return;
      }
      submittedRef.current = false;
      stagedEndpointRef.current = endpoint;
      // The chip replaces the drop zone. Focus follows to Remove only when it was in this control;
      // someone typing in another field while the file uploaded keeps their place.
      const focusWasHere = rootRef.current?.contains(document.activeElement) === true;
      setStaged(answer.body);
      if (focusWasHere) requestAnimationFrame(() => removeRef.current?.focus());
    } catch (err) {
      if (err instanceof SendInterrupted && err.aborted) return;
      setProblem(OFFLINE);
    } finally {
      if (sendingRef.current === sending) sendingRef.current = null;
      setProgress(null);
    }
  }

  function remove() {
    if (staged === null) return;
    if (!submittedRef.current) discard(stagedEndpointRef.current, staged.documentId);
    submittedRef.current = false;
    setStaged(null);
    setProblem(null);
    // The drop zone comes back in the chip's place: keep focus on the form, not the page.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const fileProblem =
    status === 'infected' ? INFECTED_FILE : status === 'rejected' ? REJECTED : null;
  const shownProblem = problem ?? fileProblem ?? error ?? null;
  const percent = progress === null ? 0 : Math.round(progress.fraction * 100);
  const scanText = file ? scanLabel(file.status) : null;
  const describedBy =
    [hint ? hintId : undefined, shownProblem ? problemId : undefined].filter(Boolean).join(' ') ||
    undefined;

  let announcement = '';
  if (progress !== null) announcement = `Uploading ${progress.name}`;
  else if (file && scanText) announcement = `${file.filename} uploaded. ${scanText.text}.`;

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={titleId}
      aria-busy={uploading || undefined}
    >
      <div className={styles.labelRow}>
        <span id={titleId} className={styles.label}>
          {label}
        </span>
        {optional ? <span className={styles.optional}>Optional</span> : null}
      </div>
      <input type="hidden" name={name} value={file?.documentId ?? ''} />

      {file ? (
        <div className={styles.chip} data-bad={badFile ? 'true' : undefined}>
          <span className={styles.chipIcon} aria-hidden="true">
            <Icon name="file-text" size={20} />
          </span>
          <span className={styles.chipText}>
            <span className={styles.chipName}>{file.filename}</span>
            <span className={styles.chipMeta}>
              <span>{formatBytes(file.sizeBytes)}</span>
              {scanText ? <Badge tone={SCAN_TONE[scanText.tone]}>{scanText.text}</Badge> : null}
            </span>
          </span>
          {scan.stalled ? (
            <Button variant="ghost" size="small" className={styles.action} onClick={scan.retry}>
              Check scan
            </Button>
          ) : null}
          <Button
            ref={removeRef}
            variant="ghost"
            size="small"
            className={styles.action}
            disabled={disabled}
            aria-label={`Remove ${file.filename}`}
            aria-describedby={shownProblem ? problemId : undefined}
            onClick={remove}
          >
            <Icon name="x" size={16} />
            <span className={styles.actionText}>Remove</span>
          </Button>
        </div>
      ) : (
        <label
          className={styles.drop}
          data-over={over ? 'true' : undefined}
          data-busy={uploading ? 'true' : undefined}
          data-disabled={disabled ? 'true' : undefined}
          data-invalid={shownProblem ? 'true' : undefined}
          onDragOver={(event) => {
            if (disabled || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = uploading ? 'none' : 'copy';
            if (!uploading) setOver(true);
          }}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            ) {
              setOver(false);
            }
          }}
          onDrop={(event) => {
            if (disabled) return;
            event.preventDefault();
            setOver(false);
            if (uploading) return;
            const dropped = event.dataTransfer.files;
            if (dropped.length === 1 && dropped[0]) void upload(dropped[0]);
            else if (dropped.length > 1) setProblem('Drop one file at a time.');
          }}
        >
          {/* Not disabled while uploading, so focus stays here; a pick during an upload is ignored. */}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            disabled={disabled}
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            aria-invalid={shownProblem ? true : undefined}
            onClick={(event) => {
              if (sendingRef.current !== null) event.preventDefault();
            }}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (selected) void upload(selected);
            }}
          />
          <span className={styles.dropIcon} aria-hidden="true">
            {uploading ? <SpinnerGlyph /> : <UploadGlyph />}
          </span>
          <span className={styles.dropText}>
            <span className={styles.dropTitle}>
              {progress !== null ? `Uploading ${progress.name}` : 'Drop a file here or choose one'}
            </span>
            {progress !== null ? (
              <span
                className={styles.progress}
                role="progressbar"
                aria-label={`Uploading ${progress.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span className={styles.progressFill} style={{ width: `${percent}%` }} />
              </span>
            ) : (
              <span className={styles.dropHint}>
                {FILE_TYPES}, up to {formatBytes(MAX_UPLOAD_BYTES)}.
              </span>
            )}
          </span>
        </label>
      )}

      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {shownProblem ? (
        <span
          id={problemId}
          className={styles.error}
          role={problem || fileProblem ? 'alert' : undefined}
        >
          {shownProblem}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

// The same two Lucide drawings as the picture upload (upload, loader-circle).
function Glyph({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      className={className}
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function UploadGlyph() {
  return (
    <Glyph>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </Glyph>
  );
}

function SpinnerGlyph() {
  return (
    <Glyph className={styles.spinner}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Glyph>
  );
}
