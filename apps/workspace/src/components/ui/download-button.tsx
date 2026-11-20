'use client';

import { useState, type ComponentProps, type ReactNode } from 'react';

import { Button } from './button';
import { downloadFile } from './download-file';
import { toast } from './toast';

export interface DownloadButtonProps {
  /** Same-origin route that answers the file as an attachment. */
  url: string;
  /** The name to save it as when the route's answer names none. */
  name: string;
  /** Refuse an answer of any other type, for example `application/pdf`. */
  expectType?: string | undefined;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  'aria-label'?: string | undefined;
  /** Called once the file was handed to the browser to save. */
  onDownload?: (() => void) | undefined;
  children: ReactNode;
}

/**
 * Download that stays in the app (round 4, R4c2): it fetches the file instead of navigating, so a refusal ("This PDF is
 * still being prepared.") is a toast here and the page stays as it was. A second click while one is under way is
 * ignored, so one click asks the route once.
 */
export function DownloadButton({
  url,
  name,
  expectType,
  variant = 'secondary',
  size,
  'aria-label': ariaLabel,
  onDownload,
  children,
}: DownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await downloadFile(url, name, expectType === undefined ? {} : { expectType });
      if (outcome.ok) onDownload?.();
      else toast.error(outcome.message, { id: 'file-download' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant={variant}
      size={size}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={() => void download()}
    >
      {children}
    </Button>
  );
}
