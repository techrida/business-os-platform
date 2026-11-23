'use client';

import { PdfPages } from '@bos/pdf-viewer';
import { useCallback, useEffect, useId, useRef, useState, type ComponentProps } from 'react';

import { Button } from './button';
import styles from './document-viewer.module.css';
import { documentStateOf } from '@/lib/document-state';

import { downloadFile } from './download-file';
import { Icon } from './icon';

export interface ViewDocumentProps {
  /** The real file name. It is the dialog title. */
  name: string;
  /** Same-origin route that streams the PDF inline. Nothing is requested until the dialog opens. */
  previewUrl: string;
  /** Same-origin route that downloads the PDF (attachment). */
  downloadUrl: string;
  /** Button text. Default "View PDF". */
  label?: string | undefined;
  variant?: 'primary' | 'secondary' | undefined;
  size?: ComponentProps<typeof Button>['size'];
  /** Also shows a Download button beside the View button (it fetches the file; see `DownloadButton`). */
  withDownload?: boolean | undefined;
  /** Called once a Download (beside the button or in the dialog) has handed the file to the browser to save. */
  onDownload?: (() => void) | undefined;
  /** Accessible name for the View button when the visible label is not enough. */
  ariaLabel?: string | undefined;
  /** Id of an element that describes the View button, such as the file-name caption. */
  describedBy?: string | undefined;
}

/**
 * A button that opens the portal's document viewer: a native `<dialog>` (focus trap, Esc and top-layer
 * backdrop come from the browser) that draws the PDF with `PdfPages`, never in an iframe. The PDF is fetched from
 * `previewUrl` once each time the dialog opens, so rendering this component costs no request. While the file is
 * still being prepared (HTTP 409 or 425) or fails, the dialog shows a message and a Retry button that makes
 * one new request per click. A 424 (the PDF failed or was refused) says it is delayed and the team has been told,
 * with no Retry. A 404 (not available, or access taken away) shows a plain "not available" message with
 * no Retry and no reason. A 410 shows the closed message (no Retry) or, for a link that ran out, a Retry that asks for
 * a fresh link. Nothing polls, because every call to such a route issues a single-use signed link.
 * Download fetches the file and saves it, so a refusal (not ready yet, signed out) is a sentence beside the button and
 * the page stays as it was (round 4, R4c2: TR-Q4). Light mode only. Full screen at 480px and below.
 *
 * @example
 *   <ViewDocument name="QT-1.pdf" previewUrl={`/quotations/${id}/document/preview`}
 *     downloadUrl={`/quotations/${id}/document`} size="small" withDownload />
 */
export function ViewDocument({
  name,
  previewUrl,
  downloadUrl,
  label = 'View PDF',
  variant = 'secondary',
  size,
  withDownload = false,
  onDownload,
  ariaLabel,
  describedBy,
}: ViewDocumentProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // The dialog's content mounts only while it is open, so the fetch below happens once per open.
  // `open` guards a second showModal() from React's development double-effect.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <span className={styles.viewDocument}>
      <Button
        variant={variant}
        size={size}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <Icon name="file-text" size={16} />
        {label}
      </Button>
      {withDownload ? (
        <DownloadButton url={downloadUrl} name={name} size={size} onDownload={onDownload} />
      ) : null}
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        // Esc and the native close both end in `close`; keep React state and focus in step.
        onClose={close}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog itself, never on its panel.
          if (event.target === event.currentTarget) close();
        }}
      >
        {open ? (
          <div className={styles.panel}>
            <header className={styles.header}>
              <h2 id={titleId} className={styles.title}>
                {name}
              </h2>
              <button
                type="button"
                className={styles.iconClose}
                aria-label="Close preview"
                onClick={close}
              >
                <Icon name="x" size={20} />
              </button>
            </header>
            <div className={styles.body}>
              <PdfStage name={name} previewUrl={previewUrl} />
            </div>
            <footer className={styles.footer}>
              {isSameOriginUrl(downloadUrl, window.location.origin) ? (
                <DownloadButton url={downloadUrl} name={name} onDownload={onDownload} />
              ) : null}
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
            </footer>
          </div>
        ) : null}
      </dialog>
    </span>
  );
}

/**
 * True for a URL that stays on `origin` over http(s). A path such as `/quotations/x/document/preview` qualifies;
 * `//evil.test/x`, `\\evil.test`, `javascript:`, `data:` and `blob:` do not.
 */
export function isSameOriginUrl(url: string, origin: string): boolean {
  if (url === '' || /^[\s\\]/.test(url) || /^\/[\\/]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === origin;
}

/**
 * Download that stays in the portal: one click fetches the route once and saves the PDF, and a refusal ("This PDF is
 * not available to download yet…") is read out beside the button instead of replacing the page. A second click while
 * one is under way is ignored. Only a same-origin route is fetched.
 */
function DownloadButton({
  url,
  name,
  size,
  onDownload,
}: {
  url: string;
  name: string;
  size?: ComponentProps<typeof Button>['size'];
  onDownload?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = isSameOriginUrl(url, window.location.origin)
        ? await downloadFile(url, name, { expectType: 'application/pdf' })
        : ({ ok: false, message: 'The file could not be downloaded.' } as const);
      if (outcome.ok) onDownload?.();
      else setMessage(outcome.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => void download()}
      >
        <DownloadIcon />
        Download
      </Button>
      {message === null ? null : (
        <span role="alert" className={styles.downloadError}>
          {message}
        </span>
      )}
    </>
  );
}

type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; data: Uint8Array }
  | { status: 'preparing' }
  | { status: 'delayed' }
  | { status: 'unavailable' }
  | { status: 'expired' }
  | { status: 'closed' }
  | { status: 'denied' }
  | { status: 'error' };

type NotReady = Exclude<PdfState['status'], 'loading' | 'ready'>;

/**
 * 409 and 425 mean "still being prepared"; 424 means the PDF failed or was refused and the team has been told, so
 * retrying now cannot help; 404 means the document is not available (never ready, or revoked), so retrying cannot
 * help; 410 is either a download link that ran out (a new request issues a fresh one, so Retry helps) or a quotation
 * the company closed (nothing to retry), told apart by the route's state header; 401 and 403 mean access was lost;
 * other non-2xx is a failure.
 */
function fetchOutcome(response: Response): 'ready' | NotReady {
  const { status } = response;
  if (status >= 200 && status < 300) return 'ready';
  if (status === 404) return 'unavailable';
  if (status === 410) return documentStateOf(response) === 'closed' ? 'closed' : 'expired';
  if (status === 409 || status === 425) return 'preparing';
  if (status === 424) return 'delayed';
  if (status === 401 || status === 403) return 'denied';
  return 'error';
}

/**
 * Fetches the PDF once when it mounts (it mounts when the dialog opens) and once more per Retry click. The
 * `requested` ref makes React's development double-effect issue one request, and a microtask check on cleanup
 * aborts the request only when the stage really unmounts.
 */
function PdfStage({ name, previewUrl }: { name: string; previewUrl: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PdfState>({ status: 'loading' });
  const requested = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const safe = isSameOriginUrl(previewUrl, window.location.origin);

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
    if (!safe || requested.current === attempt) return;
    requested.current = attempt;
    const own = new AbortController();
    controller.current = own;
    const settle = (next: PdfState) => {
      if (!own.signal.aborted && requested.current === attempt) setState(next);
    };
    fetch(previewUrl, { credentials: 'same-origin', cache: 'no-store', signal: own.signal })
      .then(async (response) => {
        const outcome = fetchOutcome(response);
        if (outcome === 'ready') {
          settle({ status: 'ready', data: new Uint8Array(await response.arrayBuffer()) });
        } else {
          settle({ status: outcome });
        }
      })
      .catch(() => settle({ status: 'error' }));
  }, [attempt, previewUrl, safe]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };

  if (!safe) {
    return (
      <Message title="No preview" text="This file could not be shown here. Download to open it." />
    );
  }
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
  if (state.status === 'preparing') {
    return (
      <Message
        title="Preparing…"
        text="Your document is being prepared. Please check again shortly."
        onRetry={retry}
      />
    );
  }
  if (state.status === 'delayed') {
    return <Message title="Delayed" text="This PDF is delayed. Our team has been told." />;
  }
  if (state.status === 'unavailable') {
    return <Message title="Not available" text="This document is not available." />;
  }
  if (state.status === 'closed') {
    return (
      <Message
        title="No longer open"
        text="This quotation is no longer open. Contact the company if you have a question."
      />
    );
  }
  if (state.status === 'expired') {
    return (
      <Message
        title="Link expired"
        text="The link to this document ran out. Retry to open it again."
        onRetry={retry}
      />
    );
  }
  if (state.status === 'denied') {
    return <Message title="No access" text="You no longer have access to this file." />;
  }
  return (
    <Message
      title="Could not load the PDF"
      text="Something went wrong while loading it."
      onRetry={retry}
    />
  );
}

function Message({
  title,
  text,
  onRetry,
}: {
  title: string;
  text: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className={styles.fallback} role="status">
      <Icon name="file-text" size={40} className={styles.fallbackIcon} />
      <p className={styles.fallbackTitle}>{title}</p>
      <p className={styles.fallbackText}>{text}</p>
      {onRetry ? (
        <Button variant="secondary" size="small" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function DownloadIcon() {
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
