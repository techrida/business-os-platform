'use client';

import { useRef, useState, type ReactNode, type RefObject } from 'react';

import { Button, LinkButton } from './button';
import { Dialog, DialogClose } from './dialog';
import { Icon } from './icon';
import { isSameOriginUrl, normalizeMime, pdfViewerUrl, previewKind } from './file-preview-model';
import styles from './file-preview-dialog.module.css';

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
  /** The element that opens the preview (a button or a file-name button). Not a link to the file. */
  trigger?: ReactNode | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Called when Download is activated, for example to show a "Download started" toast. */
  onDownload?: (() => void) | undefined;
}

/**
 * Previews an uploaded file in a dialog (UIP-FORM-003). PDFs and images are fitted to the box and keep their aspect
 * ratio; download is a secondary action in the footer. Any other type, an unsafe URL or an image that fails to load
 * shows a short message and makes Download the main action.
 *
 * Safety: HTML, SVG and unknown types are never framed, and only same-origin URLs are loaded. The route behind
 * `previewUrl` must itself answer with the stored type, `X-Content-Type-Options: nosniff` and
 * `Content-Disposition: inline`, and must allow framing by this origin (`X-Frame-Options: SAMEORIGIN`,
 * `frame-ancestors 'self'`); the app-wide `DENY` / `frame-ancestors 'none'` would show a blank frame.
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
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  onDownload,
}: FilePreviewDialogProps) {
  const [failed, setFailed] = useState(false);
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
        if (!next) setFailed(false);
        onOpenChange?.(next);
      }}
      title={name}
      size="full"
      initialFocusRef={closeRef}
      bodyClassName={styles.body}
      footer={
        <Footer
          name={name}
          mimeType={mimeType}
          previewUrl={previewUrl}
          downloadUrl={downloadUrl}
          failed={failed}
          closeRef={closeRef}
          onDownload={onDownload}
        />
      }
    >
      <Stage
        name={name}
        mimeType={mimeType}
        previewUrl={previewUrl}
        failed={failed}
        onFail={() => setFailed(true)}
      />
    </Dialog>
  );
}

/** Footer and Stage read `window.location.origin`. They only render inside the dialog portal, which mounts on the client. */
function Footer({
  name,
  mimeType,
  previewUrl,
  downloadUrl,
  failed,
  closeRef,
  onDownload,
}: Pick<
  FilePreviewDialogProps,
  'name' | 'mimeType' | 'previewUrl' | 'downloadUrl' | 'onDownload'
> & {
  failed: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  const origin = window.location.origin;
  const canPreview =
    !failed && browserCanPreview(mimeType) && isSameOriginUrl(previewUrl, origin);
  return (
    <>
      <DialogClose asChild>
        <Button ref={closeRef} variant="secondary">Close</Button>
      </DialogClose>
      {isSameOriginUrl(downloadUrl, origin) ? (
        <LinkButton
          variant={canPreview ? 'secondary' : 'primary'}
          href={downloadUrl}
          download={name}
          onClick={() => onDownload?.()}
        >
          <DownloadIcon />
          Download
        </LinkButton>
      ) : null}
    </>
  );
}

function Stage({
  name,
  mimeType,
  previewUrl,
  failed,
  onFail,
}: {
  name: string;
  mimeType: string;
  previewUrl: string;
  failed: boolean;
  onFail: () => void;
}) {
  const kind = previewKind(mimeType);
  const safe = isSameOriginUrl(previewUrl, window.location.origin);

  if (failed || !browserCanPreview(mimeType) || !safe) {
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

  return (
    <div className={styles.stage}>
      {kind === 'pdf' ? (
        <iframe
          className={styles.frame}
          src={pdfViewerUrl(previewUrl)}
          title={`Preview of ${name}`}
          referrerPolicy="no-referrer"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin stream; next/image cannot optimise it
        <img className={styles.image} src={previewUrl} alt={name} onError={onFail} />
      )}
    </div>
  );
}

function browserCanPreview(mimeType: string): boolean {
  const kind = previewKind(mimeType);
  return kind === 'image' || (kind === 'pdf' && window.navigator.pdfViewerEnabled !== false);
}

function typeLabel(mime: string): string {
  const type = normalizeMime(mime);
  const sub = type.split('/')[1];
  if (!sub) return 'This type of';
  return sub.replace(/^x-/, '').replace(/\+.*$/, '').toUpperCase();
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
