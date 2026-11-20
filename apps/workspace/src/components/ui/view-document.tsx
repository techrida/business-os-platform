'use client';

import type { ComponentProps } from 'react';

import { Button, LinkButton } from './button';
import { DownloadButton } from './download-button';
import { DownloadIcon, FilePreviewDialog } from './file-preview-dialog';
import { Icon } from './icon';
import styles from './file-preview-dialog.module.css';

export interface ViewDocumentProps {
  /** The real file name. It is the dialog title. */
  name: string;
  /** Same-origin route that streams the file inline. Nothing is requested until the dialog opens. */
  previewUrl: string;
  /** Same-origin route that downloads the file (attachment). */
  downloadUrl: string;
  /** The stored MIME type. Default `application/pdf`. */
  mimeType?: string | undefined;
  /** Button text. Default "View PDF"; callers showing other file types pass "View". */
  label?: string | undefined;
  /** `link` is an inline text-style button for tables and fact lists. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | undefined;
  size?: ComponentProps<typeof Button>['size'];
  /** Also shows a plain Download link next to the button. It never prefetches: it is a normal anchor. */
  withDownload?: boolean | undefined;
  /** Called when a Download link (beside the button or in the dialog) is activated. */
  onDownload?: (() => void) | undefined;
  /** Accessible name for the button and Download link when the visible text lacks context, e.g. "version 2". */
  context?: string | undefined;
  /**
   * Same-origin route that asks for a fresh PDF when the file could not be prepared. Pass it only for staff
   * viewers of a document that can be regenerated; without it the dialog offers no Retry.
   */
  retryUrl?: string | undefined;
  /** See FilePreviewDialog: a generated PDF whose route answers 409 while it is being prepared is checked again. */
  pollWhilePreparing?: boolean | undefined;
  /** Both Download controls fetch the file and keep a refusal in the app (FilePreviewDialog `downloadInApp`). */
  downloadInApp?: boolean | undefined;
}

/**
 * A button that opens the shared document viewer (`FilePreviewDialog`) on `previewUrl`. The viewer fetches the file
 * once per open, so rendering this component costs no request, and a signed-link route is not hit by page loads.
 *
 * @example
 *   <ViewDocument name="Q-1042.pdf" previewUrl={`/api/quotations/${id}/pdf`} downloadUrl={`/api/quotations/${id}/pdf?download=1`} withDownload />
 */
export function ViewDocument({
  name,
  previewUrl,
  downloadUrl,
  mimeType = 'application/pdf',
  label = 'View PDF',
  variant = 'secondary',
  size,
  withDownload = false,
  onDownload,
  context,
  retryUrl,
  pollWhilePreparing,
  downloadInApp,
}: ViewDocumentProps) {
  const content = (
    <>
      <Icon name="file-text" size={16} />
      {label}
    </>
  );
  const trigger =
    variant === 'link' ? (
      <button
        type="button"
        className={styles.linkTrigger}
        aria-label={context ? `${label} ${context}` : undefined}
      >
        {content}
      </button>
    ) : (
      <Button
        variant={variant}
        size={size}
        aria-label={context ? `${label} ${context}` : undefined}
      >
        {content}
      </Button>
    );
  return (
    <span className={styles.viewDocument}>
      <FilePreviewDialog
        name={name}
        mimeType={mimeType}
        previewUrl={previewUrl}
        downloadUrl={downloadUrl}
        trigger={trigger}
        onDownload={onDownload}
        retryUrl={retryUrl}
        pollWhilePreparing={pollWhilePreparing}
        downloadInApp={downloadInApp}
      />
      {withDownload && downloadInApp ? (
        <DownloadButton
          url={downloadUrl}
          name={name}
          expectType={mimeType === 'application/pdf' ? 'application/pdf' : undefined}
          size={size}
          aria-label={context ? `Download ${context}` : undefined}
          onDownload={onDownload}
        >
          <DownloadIcon />
          Download
        </DownloadButton>
      ) : withDownload ? (
        <LinkButton
          variant="secondary"
          size={size}
          href={downloadUrl}
          aria-label={context ? `Download ${context}` : undefined}
          onClick={() => onDownload?.()}
        >
          <DownloadIcon />
          Download
        </LinkButton>
      ) : null}
    </span>
  );
}
