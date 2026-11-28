'use client';

import { PdfPages } from '@bos/pdf-viewer';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Button, LinkButton } from './button';
import { Dialog, DialogClose } from './dialog';
import { DownloadButton } from './download-button';
import { Icon } from './icon';
import {
  isSameOriginUrl,
  normalizeMime,
  previewFetchOutcome,
  previewKind,
} from './file-preview-model';
import styles from './file-preview-dialog.module.css';
import { requestPdfRetry } from './pdf-retry';
import { toast } from './toast';
import { usePreparePoll } from './use-prepare-poll';

export interface FilePreviewDialogProps {
  /** Display name. It is the dialog title and the image's alt text, so use the real file name. */
  name: string;
  /** The stored MIME type. Only `application/pdf` and raster images (png, jpeg, gif, webp, avif) preview. */
  mimeType: string;
  /**
   * Where the browser may load the file to draw it, inline. It must be on this app's own origin (a path such as
   * `/api/documents/<id>/versions/<id>/preview` is ideal). A URL on any other origin is refused and the dialog
   * shows the download fallback instead of framing it.
   */
  previewUrl: string;
  /** Where the file downloads from (attachment). Also same-origin only; a refused URL hides the Download button. */
  downloadUrl: string;
  /**
   * Staff only. A same-origin route that takes a POST to put a failed PDF back in the render queue. When the preview
   * route answers 424 ("could not be prepared"), Retry posts here first, then loads the file again. Without it, a
   * failed PDF shows its message and no Retry, because loading it again would fail the same way.
   */
  retryUrl?: string | undefined;
  /**
   * For a generated PDF whose route answers 409 while it is being prepared (the quotation, invoice and purchase order
   * PDFs): keep checking on the shared schedule (use-prepare-poll.ts) and show the file as soon as it is there. Such a
   * route refuses before it issues a signed link, so a check costs no link. Leave it off for other files.
   */
  pollWhilePreparing?: boolean | undefined;
  /**
   * Download fetches the file and saves it, so a refusal is a toast in the app instead of an error page in the tab.
   * A PDF must come back as `application/pdf`.
   */
  downloadInApp?: boolean | undefined;
  /** The element that opens the preview (a button or a file-name button). Not a link to the file. */
  trigger?: ReactNode | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Called when Download is activated, for example to show a "Download started" toast. */
  onDownload?: (() => void) | undefined;
  /** Optional content below the preview, such as fields to edit an attachment. */
  children?: ReactNode | undefined;
  /** Replaces the media while there is no previewable version yet. */
  placeholder?: ReactNode | undefined;
  /** Additional control layered above the stage. */
  stageOverlay?: ReactNode | undefined;
  /** Replaces Close with the caller's actions, after the shared Download control. */
  actions?: ReactNode | undefined;
  locked?: boolean | undefined;
  closeOnOutsideClick?: boolean | undefined;
}

/**
 * The shared document viewer (UIP-FORM-003). Images are fitted to the box and keep their aspect ratio. A PDF is
 * fetched from `previewUrl` once each time the dialog opens and drawn by `PdfPages`, never in an iframe. While the
 * file is still being prepared (HTTP 409 or 425) or fails to load, the dialog shows a message and a Retry button; Retry
 * makes one new request per click. Nothing polls unless `pollWhilePreparing` says the route refuses a file that is
 * being prepared before it issues a signed link; then the dialog checks again by itself on the shared schedule and
 * offers "Check again" when that runs out. A PDF that could not be prepared (424) offers Retry only when `retryUrl`
 * is given (staff), and Retry asks that route to queue the render again before loading the file. A missing PDF (404
 * or 410) says so and offers no Retry. Download is a secondary action in the footer; with `downloadInApp` it fetches
 * the file and a refusal stays in the app. Any other type or an unsafe URL shows a short message and makes Download
 * the main action.
 *
 * Safety: HTML, SVG and unknown types are never framed, and only same-origin URLs are loaded. The route behind
 * `previewUrl` must answer with the stored type, `X-Content-Type-Options: nosniff` and `Content-Disposition: inline`.
 * It is requested with the user's own same-origin credentials and `cache: 'no-store'`. Nothing is requested while the
 * dialog is closed.
 *
 * @example
 *   <FilePreviewDialog
 *     name={file.name}
 *     mimeType={file.mimeType}
 *     previewUrl={`/api/documents/${doc.id}/versions/${v.id}/preview`}
 *     downloadUrl={`/api/documents/${doc.id}/versions/${v.id}/download`}
 *     trigger={<button type="button">{file.name}</button>}
 *     onDownload={() => toast.info('Download started')}
 *   />
 */
export function FilePreviewDialog({
  name,
  mimeType,
  previewUrl,
  downloadUrl,
  retryUrl,
  pollWhilePreparing,
  downloadInApp,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  onDownload,
  children,
  placeholder,
  stageOverlay,
  actions,
  locked,
  closeOnOutsideClick,
}: FilePreviewDialogProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === previewUrl;
  const hasStageSlot = placeholder !== undefined || stageOverlay !== undefined;
  const stage = placeholder ?? (
    <Stage
      name={name}
      mimeType={mimeType}
      previewUrl={previewUrl}
      retryUrl={retryUrl}
      poll={pollWhilePreparing === true}
      failed={failed}
      onFail={() => setFailedUrl(previewUrl)}
    />
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialog = {
    ...(trigger ? { trigger } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(defaultOpen !== undefined ? { defaultOpen } : {}),
  };
  return (
    <Dialog
      {...dialog}
      onOpenChange={(next) => {
        if (!next && !locked) setFailedUrl(null);
        onOpenChange?.(next);
      }}
      title={name}
      size="full"
      className={styles.dialog}
      locked={locked}
      closeOnOutsideClick={closeOnOutsideClick}
      bodyClassName={children || hasStageSlot ? styles.editBody : styles.body}
      initialFocusRef={actions === undefined ? closeRef : undefined}
      footer={
        <Footer
          name={name}
          mimeType={mimeType}
          downloadInApp={downloadInApp === true}
          previewUrl={previewUrl}
          downloadUrl={downloadUrl}
          failed={failed}
          closeRef={closeRef}
          onDownload={onDownload}
          actions={actions}
        />
      }
    >
      {hasStageSlot ? (
        <div className={styles.stageSlot}>
          {placeholder !== undefined ? <div className={styles.stage}>{stage}</div> : stage}
          {stageOverlay ? <div className={styles.overlaySlot}>{stageOverlay}</div> : null}
        </div>
      ) : (
        stage
      )}
      {children}
    </Dialog>
  );
}

/** Footer and Stage read `window.location.origin`. They only render inside the dialog portal, which mounts on the client. */
function Footer({
  name,
  mimeType,
  downloadInApp,
  previewUrl,
  downloadUrl,
  failed,
  closeRef,
  onDownload,
  actions,
}: Pick<
  FilePreviewDialogProps,
  'name' | 'mimeType' | 'previewUrl' | 'downloadUrl' | 'onDownload' | 'actions'
> & {
  downloadInApp: boolean;
  failed: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  const origin = window.location.origin;
  const canPreview = !failed && canPreviewKind(mimeType) && isSameOriginUrl(previewUrl, origin);
  return (
    <>
      {actions === undefined ? (
        <DialogClose asChild>
          <Button ref={closeRef} variant="secondary">
            Close
          </Button>
        </DialogClose>
      ) : null}
      {!isSameOriginUrl(downloadUrl, origin) ? null : downloadInApp ? (
        <DownloadButton
          url={downloadUrl}
          name={name}
          expectType={previewKind(mimeType) === 'pdf' ? 'application/pdf' : undefined}
          variant={canPreview || actions !== undefined ? 'secondary' : 'primary'}
          onDownload={onDownload}
        >
          <DownloadIcon />
          Download
        </DownloadButton>
      ) : (
        <LinkButton
          variant={canPreview || actions !== undefined ? 'secondary' : 'primary'}
          href={downloadUrl}
          onClick={() => onDownload?.()}
        >
          <DownloadIcon />
          Download
        </LinkButton>
      )}
      {actions}
    </>
  );
}

function Stage({
  name,
  mimeType,
  previewUrl,
  retryUrl,
  poll,
  failed,
  onFail,
}: {
  name: string;
  mimeType: string;
  previewUrl: string;
  retryUrl: string | undefined;
  poll: boolean;
  failed: boolean;
  onFail: () => void;
}) {
  const kind = previewKind(mimeType);
  const safe = isSameOriginUrl(previewUrl, window.location.origin);

  if (failed || !canPreviewKind(mimeType) || !safe) {
    return (
      <div className={styles.fallback} role="status">
        <Icon name="file-text" size={40} className={styles.fallbackIcon} />
        <p className={styles.fallbackTitle}>No preview</p>
        <p className={styles.fallbackText}>
          {kind === 'unsupported'
            ? `${typeLabel(mimeType)} files cannot be shown here. Download to open it.`
            : 'This file could not be shown here. Download to open it.'}
        </p>
      </div>
    );
  }

  if (kind === 'pdf')
    return (
      <PdfStage
        key={previewUrl}
        name={name}
        previewUrl={previewUrl}
        retryUrl={retryUrl}
        poll={poll}
      />
    );

  return (
    <div className={styles.stage}>
      {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin stream; next/image cannot optimise it */}
      <img className={styles.image} src={previewUrl} alt={name} onError={onFail} />
    </div>
  );
}

type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; data: Uint8Array }
  | { status: 'preparing' }
  | { status: 'failed' }
  | { status: 'unavailable' }
  | { status: 'denied' }
  | { status: 'error' };

/**
 * Fetches the PDF once when it mounts (it mounts when the dialog opens) and once more per Retry click, and, with
 * `poll`, on the shared schedule while the route answers "being prepared". The `requested` ref makes React's
 * development double-effect issue one request, and a microtask check on cleanup aborts the request only when the stage
 * really unmounts.
 */
function PdfStage({
  name,
  previewUrl,
  retryUrl,
  poll,
}: {
  name: string;
  previewUrl: string;
  retryUrl: string | undefined;
  poll: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState(false);
  const asked = useRef(false);
  const [state, setState] = useState<PdfState>({ status: 'loading' });
  const requested = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = controller.current;
      queueMicrotask(() => {
        if (!mounted.current) pending?.abort();
      });
    };
  }, []);

  useEffect(() => {
    if (requested.current === attempt) return;
    requested.current = attempt;
    const own = new AbortController();
    controller.current = own;
    inFlight.current = true;
    const settle = (next: PdfState) => {
      if (!own.signal.aborted && requested.current === attempt) setState(next);
    };
    fetch(previewUrl, { credentials: 'same-origin', cache: 'no-store', signal: own.signal })
      .then(async (response) => {
        const outcome = previewFetchOutcome(response.status);
        if (outcome === 'ready') {
          settle({ status: 'ready', data: new Uint8Array(await response.arrayBuffer()) });
        } else {
          settle({ status: outcome });
        }
      })
      .catch(() => settle({ status: 'error' }))
      .finally(() => {
        if (requested.current === attempt) inFlight.current = false;
      });
  }, [attempt, previewUrl]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };
  // While the route says "being prepared", check again by itself; the words stay until the answer changes.
  const watch = usePreparePoll(poll && state.status === 'preparing', () => {
    // The schedule is short at first: never start a second download while the last one is still arriving.
    if (!inFlight.current) setAttempt((current) => current + 1);
  });

  /** Failed render: ask the API to queue it again once, then load the file again. A second click while asking is ignored. */
  const retryFailed = async () => {
    if (asked.current || retryUrl === undefined) return;
    asked.current = true;
    setAsking(true);
    const outcome = await requestPdfRetry(retryUrl);
    asked.current = false;
    if (!mounted.current) return;
    setAsking(false);
    if (outcome === 'failed') {
      toast.error('Could not request a retry', { id: 'pdf-retry' });
      return;
    }
    // 409 means the render is no longer failed, so loading the file again shows what it is now.
    if (outcome === 'queued') toast.success('Retry requested', { id: 'pdf-retry' });
    retry();
  };

  if (state.status === 'ready') {
    return (
      <div className={styles.pdfStage}>
        <PdfPages
          data={state.data}
          title={`Preview of ${name}`}
          className={styles.pdfPages}
          onError={() => setState({ status: 'error' })}
        />
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className={styles.fallback} role="status" aria-busy="true">
        <p className={styles.fallbackText}>Loading the PDF…</p>
      </div>
    );
  }
  const message =
    state.status === 'preparing' && poll
      ? {
          title: 'Preparing PDF',
          text: watch.expired
            ? 'This PDF is taking longer than usual.'
            : 'It opens here as soon as it is ready.',
          retry: watch.expired ? ('check' as const) : null,
        }
      : state.status === 'preparing'
        ? { title: 'Preparing…', text: 'This PDF is still being prepared.', retry: retry }
        : state.status === 'failed'
          ? {
              title: 'Could not prepare',
              text: 'The PDF could not be prepared.',
              retry: retryUrl === undefined ? null : ('ask' as const),
            }
          : state.status === 'unavailable'
            ? { title: 'Not available', text: 'This PDF is not available.', retry: null }
            : state.status === 'denied'
              ? {
                  title: 'No access',
                  text: 'You no longer have access to this file.',
                  retry: null,
                }
              : {
                  title: 'Could not load the PDF',
                  text: 'Something went wrong while loading it.',
                  retry: 'load' as const,
                };
  return (
    <div className={styles.fallback} role="status">
      <Icon name="file-text" size={40} className={styles.fallbackIcon} />
      <p className={styles.fallbackTitle}>{message.title}</p>
      <p className={styles.fallbackText}>{message.text}</p>
      {message.retry ? (
        <Button
          variant="secondary"
          size="small"
          disabled={asking}
          onClick={() => {
            if (message.retry === 'ask') void retryFailed();
            else if (message.retry === 'check') {
              watch.restart();
              setAttempt((current) => current + 1);
            } else retry();
          }}
        >
          {message.retry === 'check' ? 'Check again' : 'Retry'}
        </Button>
      ) : null}
    </div>
  );
}

function canPreviewKind(mimeType: string): boolean {
  return previewKind(mimeType) !== 'unsupported';
}

function typeLabel(mime: string): string {
  const type = normalizeMime(mime);
  const sub = type.split('/')[1];
  if (!sub) return 'This type of';
  return sub.replace(/^x-/, '').replace(/\+.*$/, '').toUpperCase();
}

export function DownloadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}
