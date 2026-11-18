'use client';

import type { ChecklistItem, VerificationStatus } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { downloadHref, previewHref, type FileView } from '@/components/p2/crm/verification-file';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogClose } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { toast } from '@/components/ui/toast';
import { formatBytes, guessMime, scanLabel } from '@/lib/kernel-ui';

import { attachDocumentAction, type AttachDocumentState } from '../case-actions';
import styles from '../verification.module.css';
import { RemoveFileDialog } from './remove-file-dialog';
import { useFileScan } from './use-file-scan';

interface Edit {
  version: number;
  expiresOn: string;
  key: string;
  originalId: string | null;
  staged: FileView | null;
  safeToDiscard: boolean;
  retryOnly?: boolean;
}

const SCAN_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

export function CheckMark({ animate = false }: { animate?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path className={animate ? styles.scanCheck : undefined} pathLength="1" d="m3 8 3 3 7-7" />
    </svg>
  );
}

function ScanBadge({ file, animate }: { file: FileView; animate: boolean }) {
  const scan = scanLabel(file.status);
  return (
    <Badge tone={SCAN_TONE[scan.tone]} role="status">
      <span className={styles.scanBadge}>
        {file.status === 'clean' ? (
          <>
            <CheckMark animate={animate} /> Virus free
          </>
        ) : (
          scan.text
        )}
      </span>
    </Badge>
  );
}

function discard(staged: FileView | null) {
  if (!staged) return;
  // This is only called for a fresh upload that Save has never attached or possibly attached.
  // The route also enforces the owner's document permission and the case's editable state.
  void fetch(`/api/documents/${encodeURIComponent(staged.documentId)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {});
}

export function ChecklistFile({
  caseId,
  version,
  caseStatus,
  item,
  label,
  file,
  mayAttach,
  mayRemove,
  allowedMime,
  maxBytes,
}: {
  caseId: string;
  version: number;
  caseStatus: VerificationStatus;
  item: ChecklistItem;
  label: string;
  file: FileView | null;
  mayAttach: boolean;
  mayRemove: boolean;
  allowedMime: string[];
  maxBytes: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<'uploading' | 'saving' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [calendarContainer, setCalendarContainer] = useState<HTMLElement | undefined>();
  const dateFieldRef = useCallback((node: HTMLDivElement | null) => {
    setCalendarContainer(node?.closest<HTMLElement>('[role="dialog"]') ?? undefined);
  }, []);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [problem, setProblem] = useState<AttachDocumentState | null>(null);
  const viewScan = useFileScan(caseId, file, true);
  const stagedScan = useFileScan(caseId, edit?.staged ?? null, edit !== null);
  // Refresh approval readiness after an active file finishes. The fetch that checks the scan
  // does not refresh the page on intermediate results or while only a staged upload is scanning.
  useEffect(() => {
    if (viewScan.finished) router.refresh();
  }, [router, viewScan.finished]);

  const current = viewScan.file;
  const attached = item.documentId !== null;
  const editing = edit !== null;
  const busy = phase !== null;
  const stale = editing && (edit.version !== version || !mayAttach);
  const mayPick = mayAttach && !busy && !stale && !edit?.retryOnly;
  const previewScan = edit?.staged ? stagedScan : viewScan;
  const preview = previewScan.file;
  const clean = preview?.status === 'clean';

  function initialEdit(): Edit {
    return {
      version,
      expiresOn: item.expiresOn ?? '',
      key: crypto.randomUUID(),
      originalId: item.documentId,
      staged: null,
      safeToDiscard: true,
    };
  }

  function closeEdit() {
    if (inFlight.current || edit === null) return;
    if (edit.safeToDiscard) discard(edit.staged);
    setProblem(null);
    setEdit(null);
    requestAnimationFrame(() => rowButton.current?.focus());
  }

  function uploadError(message: string) {
    if (editing) setProblem({ key: edit.key, error: message });
    else setRowError(message);
  }

  async function upload(selected: File) {
    if (!mayPick || inFlight.current) return;
    const mime = guessMime(selected.name, selected.type);
    if (selected.size === 0) return uploadError('That file is empty.');
    if (selected.size > maxBytes) return uploadError(`The file limit is ${formatBytes(maxBytes)}.`);
    if (!allowedMime.includes(mime)) {
      return uploadError('Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.');
    }

    const draft = edit ?? initialEdit();
    inFlight.current = true;
    setPhase('uploading');
    setRowError(null);
    setProblem(null);
    try {
      const response = await fetch(`/verification/${caseId}/documents`, {
        method: 'POST',
        headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(selected.name) },
        body: selected,
      });
      if (response.status === 401) {
        // The login endpoint is a Route Handler and needs a document navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(`/verification/${caseId}`)}`;
        return;
      }
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        uploadError(result?.error?.message ?? 'The upload did not finish. Try again.');
        return;
      }
      const staged = (await response.json()) as FileView;
      if (draft.safeToDiscard) discard(draft.staged);
      setEdit({ ...draft, staged, safeToDiscard: true });
    } catch {
      uploadError('The upload was interrupted. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setPhase(null);
    }
  }

  async function save() {
    const documentId = edit?.staged?.documentId ?? edit?.originalId;
    if (!edit || !documentId || inFlight.current || stale || problem?.reload || problem?.reupload)
      return;
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('key', item.key);
    form.set('expectedVersion', String(edit.version));
    form.set('idempotencyKey', edit.key);
    form.set('documentId', documentId);
    form.set('expiresOn', edit.expiresOn);
    setProblem(null);
    inFlight.current = true;
    setPhase('saving');
    try {
      const result = await attachDocumentAction({ key: edit.key }, form);
      if (!result.attached) {
        const uncertain = result.key === edit.key;
        setEdit({
          ...edit,
          key: result.key,
          safeToDiscard: edit.safeToDiscard && !uncertain,
          retryOnly: uncertain && !result.reload,
        });
        setProblem(result);
        return;
      }
      setEdit(null);
      toast.success(edit.staged ? 'File attached' : 'Expiry saved');
      requestAnimationFrame(() => rowButton.current?.focus());
    } catch {
      setEdit({ ...edit, safeToDiscard: false, retryOnly: true });
      setProblem({ key: edit.key, error: 'Save could not be confirmed. Try again.' });
    } finally {
      inFlight.current = false;
      setPhase(null);
    }
  }

  function reloadEdit() {
    closeEdit();
    router.refresh();
  }

  return (
    <div
      className={`${styles.fileCell} ${dragging ? styles.dragging : ''}`}
      onDragOver={(event) => {
        if (!mayAttach || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = mayPick ? 'copy' : 'none';
        if (mayPick) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!mayAttach || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        if (!mayPick) return;
        const selected = event.dataTransfer.files;
        if (selected.length === 1 && selected[0]) void upload(selected[0]);
        else uploadError('Drop one file at a time.');
      }}
    >
      <div className={styles.file}>
        {mayAttach ? (
          <input
            ref={fileInput}
            type="file"
            hidden
            accept={allowedMime.join(',')}
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (selected) void upload(selected);
            }}
          />
        ) : null}
        {mayAttach && !attached ? (
          <Button
            ref={rowButton}
            variant="secondary"
            size="small"
            disabled={busy}
            aria-label={phase === 'uploading' ? `Uploading ${label}` : `Upload ${label}`}
            onClick={() => fileInput.current?.click()}
          >
            {phase === 'uploading' ? 'Uploading…' : 'Upload'}
          </Button>
        ) : null}
        {mayAttach || editing || current?.status === 'clean' ? (
          <FilePreviewDialog
            name={preview?.filename ?? label}
            mimeType={clean ? preview.mimeType : ''}
            previewUrl={clean ? previewHref(preview) : ''}
            downloadUrl={clean ? downloadHref(preview) : ''}
            trigger={
              attached && (mayAttach || current?.status === 'clean') ? (
                <Button
                  ref={rowButton}
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${mayAttach ? 'Change' : 'View'} ${label}`}
                >
                  {mayAttach ? 'Change' : 'View'}
                </Button>
              ) : undefined
            }
            open={mayAttach || editing ? editing : undefined}
            onOpenChange={
              mayAttach || editing
                ? (next) => {
                    if (next && mayAttach && !inFlight.current) {
                      setEdit(initialEdit());
                      setRowError(null);
                    } else if (!next) {
                      // Radix gets Escape before the nested calendar. Let that key close the calendar first.
                      const calendarOpen = calendarContainer?.querySelector(
                        '[aria-haspopup="dialog"][aria-expanded="true"]',
                      );
                      if (!calendarOpen) closeEdit();
                    }
                  }
                : undefined
            }
            onDownload={() => toast.info('Download started')}
            locked={busy}
            closeOnOutsideClick={!editing}
            placeholder={
              !clean ? (
                <span className={styles.previewStatus}>
                  {preview ? (
                    <ScanBadge file={preview} animate={false} />
                  ) : (
                    'File details unavailable'
                  )}
                </span>
              ) : undefined
            }
            stageOverlay={
              editing ? (
                <Button
                  className={styles.replace}
                  variant="secondary"
                  disabled={!mayPick}
                  onClick={() => fileInput.current?.click()}
                >
                  {phase === 'uploading' ? 'Uploading…' : 'Replace file'}
                </Button>
              ) : undefined
            }
            actions={
              editing ? (
                <>
                  <DialogClose asChild>
                    <Button variant="secondary" disabled={busy}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    onClick={() => void save()}
                    disabled={
                      busy ||
                      stale ||
                      problem?.reload ||
                      problem?.reupload ||
                      (!edit.staged &&
                        (item.status === 'rejected' ||
                          !edit.originalId ||
                          edit.expiresOn === (item.expiresOn ?? '')))
                    }
                    aria-busy={phase === 'saving' || undefined}
                  >
                    {phase === 'saving' ? 'Saving…' : 'Save'}
                  </Button>
                </>
              ) : undefined
            }
          >
            {editing ? (
              <div className={styles.editFields}>
                {problem?.error || stale ? (
                  <Alert
                    tone="error"
                    role="alert"
                    actions={
                      problem?.reload || stale ? (
                        <Button variant="ghost" onClick={reloadEdit}>
                          Reload this case
                        </Button>
                      ) : null
                    }
                  >
                    {problem?.error ??
                      'This case changed. Reopen this document to edit the latest version.'}
                  </Alert>
                ) : null}
                {previewScan.stalled ? (
                  <Alert
                    tone="warning"
                    role="status"
                    actions={
                      <Button variant="ghost" onClick={previewScan.retry}>
                        Check again
                      </Button>
                    }
                  >
                    The scan result is still unavailable.
                  </Alert>
                ) : null}
                {clean && edit.staged ? (
                  <ScanBadge file={preview} animate={previewScan.drewCheck} />
                ) : null}
                {caseStatus === 'rejected' ? (
                  <p className={styles.note}>
                    {item.status === 'rejected'
                      ? 'Replace the rejected file to reopen this case.'
                      : 'Saving reopens this case as a draft.'}
                  </p>
                ) : null}
                <div ref={dateFieldRef} className={styles.dateField}>
                  <Field label="Expiry date">
                    {(control) => (
                      <DatePicker
                        {...control}
                        popoverContainer={calendarContainer}
                        value={edit.expiresOn}
                        onChange={(expiresOn) => setEdit({ ...edit, expiresOn })}
                        disabled={busy || stale || edit.retryOnly}
                      />
                    )}
                  </Field>
                  {edit.expiresOn ? (
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={busy || stale || edit.retryOnly}
                      onClick={() => setEdit({ ...edit, expiresOn: '' })}
                    >
                      Clear date
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </FilePreviewDialog>
        ) : null}
        {current ? (
          <>
            <span className={styles.quiet}>{formatBytes(current.sizeBytes)}</span>
            <ScanBadge file={current} animate={viewScan.drewCheck} />
          </>
        ) : attached ? (
          <span className={styles.quiet}>File details unavailable</span>
        ) : null}
        {!attached && !mayAttach ? (
          <span className={styles.quiet} aria-label="No file">
            —
          </span>
        ) : null}
        {mayRemove && attached ? (
          <RemoveFileDialog
            caseId={caseId}
            version={version}
            itemKey={item.key}
            label={label}
            filename={current?.filename ?? label}
            reopens={caseStatus === 'rejected'}
            disabled={busy}
            onRemoved={() => requestAnimationFrame(() => rowButton.current?.focus())}
          />
        ) : null}
        {viewScan.stalled ? (
          <Button size="small" variant="ghost" onClick={viewScan.retry}>
            Check scan
          </Button>
        ) : null}
      </div>
      {rowError ? (
        <p className={styles.rowError} role="alert">
          {rowError}
        </p>
      ) : null}
    </div>
  );
}
