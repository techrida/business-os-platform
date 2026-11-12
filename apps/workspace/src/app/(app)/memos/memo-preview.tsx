'use client';
import type { MemoTemplateSnapshot } from '@bos/contracts';
import { useId, useState } from 'react';

import { memoPdfInputOf } from '@/lib/memo-pdf-input';

import { DownloadIcon, PrintIcon } from './memo-icons';
import { downloadMemoPdf, printMemoPaper, type PdfSource } from './memo-pdf-client';
import { MemoPaper } from './memo-paper';
import styles from './memo-template.module.css';

/**
 * The memo paper with its two icon-only actions: download the real PDF, print only the paper. On a wide screen the
 * whole block sticks under the app header while the editor beside it scrolls; a paper taller than the screen scrolls
 * inside the block, so the actions stay reachable. On a phone it simply stacks below the form.
 *
 * `source` decides what the PDF is made from: the saved memo on the server (its stored, frozen values) or the
 * values currently in the form.
 */
export function MemoPreview({
  template,
  title,
  body,
  source,
  sticky = false,
  noun = 'memo',
}: {
  template: MemoTemplateSnapshot;
  title: string;
  body: string;
  source: PdfSource | 'current';
  sticky?: boolean;
  /** Names what the actions act on, for example "memo" or "preview". */
  noun?: string;
}) {
  const paperId = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const pdfSource: PdfSource =
    source === 'current' ? { kind: 'draft', input: memoPdfInputOf(template, title, body) } : source;

  return (
    <div className={[styles.preview, sticky ? styles.sticky : undefined].filter(Boolean).join(' ')}>
      <div className={styles.previewBar} role="toolbar" aria-label={`${noun} actions`}>
        <button
          type="button"
          className={styles.iconAction}
          aria-label={`Download ${noun} as PDF`}
          title={`Download ${noun} as PDF`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void downloadMemoPdf(pdfSource).then((outcome) => {
              setMessage({ ok: outcome.ok, text: outcome.message });
              setBusy(false);
            });
          }}
        >
          <DownloadIcon size={18} />
        </button>
        <button
          type="button"
          className={styles.iconAction}
          aria-label={`Print ${noun}`}
          title={`Print ${noun}`}
          onClick={() => {
            setMessage(null);
            void printMemoPaper(paperId).then((ok) => {
              if (!ok) setMessage({ ok: false, text: 'The memo could not be printed. Try again.' });
            });
          }}
        >
          <PrintIcon size={18} />
        </button>
        <p
          className={message && !message.ok ? styles.previewError : styles.previewStatus}
          role="status"
          aria-live="polite"
        >
          {message?.text ?? ''}
        </p>
      </div>
      <div
        className={styles.previewScroll}
        tabIndex={0}
        role="region"
        aria-label={`Scrollable ${noun}`}
      >
        <MemoPaper id={paperId} template={template} title={title} body={body} />
      </div>
    </div>
  );
}
