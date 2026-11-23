'use client';
import type { MemoTemplateSnapshot } from '@bos/contracts';
import { useEffect, useId, useRef, useState } from 'react';

import { memoPdfInputOf } from '@/lib/memo-pdf-input';

import { DownloadIcon, PrintIcon } from './memo-icons';
import type { PdfSource } from './memo-pdf-client';
import { MemoPaper } from './memo-paper';
import styles from './memo-template.module.css';
import { useMemoPdfActions } from './use-memo-pdf-actions';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * Whether the block is short enough to stay in view under the app header. A paper taller than the screen is not
 * made sticky: it flows with the page, so every part of it is reachable by ordinary scrolling and nothing scrolls
 * inside it. (A sticky block taller than the viewport hides its lower part until the column ends.)
 */
function useFitsViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const measure = () => {
      const header = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--bos-header-height'),
      );
      const room = window.innerHeight - (Number.isFinite(header) ? header : 64) - 32;
      setFits(el.offsetHeight <= room);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [enabled]);
  return { ref, fits: enabled && fits };
}

/**
 * The memo paper with its two icon-only actions: download the real PDF, print only the paper. Results appear as
 * toasts. On a wide screen a paper that fits the screen sticks under the app header while the editor beside it
 * scrolls; a taller one flows with the page. On a phone it simply stacks below the form.
 *
 * `source` decides what the PDF is made from: the saved memo on the server (its stored, frozen values) or the
 * values currently in the form. A form that shows its own Download and Print (its footer) passes `showActions={false}`
 * and `paperId`, and drives the same actions through `useMemoPdfActions`.
 */
export function MemoPreview({
  template,
  title,
  body,
  source,
  sticky = false,
  noun = 'memo',
  showActions = true,
  paperId,
}: {
  template: MemoTemplateSnapshot;
  title: string;
  body: string;
  source: PdfSource | 'current';
  sticky?: boolean;
  /** Names what the actions act on, for example "memo" or "preview". */
  noun?: string;
  showActions?: boolean;
  /** The id of the paper element, so a Print button elsewhere can find exactly this paper. */
  paperId?: string;
}) {
  const ownId = useId();
  const id = paperId ?? ownId;
  const pdfSource: PdfSource =
    source === 'current' ? { kind: 'draft', input: memoPdfInputOf(template, title, body) } : source;
  const { busy, download, print } = useMemoPdfActions(pdfSource, id);
  const { ref, fits } = useFitsViewport(sticky);

  return (
    <div
      ref={ref}
      className={[styles.preview, fits ? styles.sticky : undefined].filter(Boolean).join(' ')}
    >
      {showActions ? (
        <div className={styles.previewBar} role="toolbar" aria-label={`${noun} actions`}>
          <Tooltip content={`Download ${noun} as PDF`}>
            <button
              type="button"
              className={styles.iconAction}
              aria-label={`Download ${noun} as PDF`}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void download();
              }}
            >
              <DownloadIcon size={18} />
            </button>
          </Tooltip>
          <Tooltip content={`Print ${noun}`}>
            <button
              type="button"
              className={styles.iconAction}
              aria-label={`Print ${noun}`}
              onClick={() => void print()}
            >
              <PrintIcon size={18} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <h2 className={styles.previewHeading}>Live preview</h2>
      )}
      <MemoPaper id={id} template={template} title={title} body={body} />
    </div>
  );
}
