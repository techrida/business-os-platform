'use client';

import type { DocumentLayout } from '@bos/contracts';
import { DOCUMENT_LAYOUT_LABELS } from '@bos/contracts';
import { useEffect, useRef, useState } from 'react';

import styles from './document-style-form.module.css';

// The renderer lays a quotation out on A4 at 96 dpi; the frame scales that page down to its own width.
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const INITIAL_SCALE = 0.16;

/**
 * A scaled A4 page. `html` is the real renderer's output, drawn in a sandboxed frame with no
 * permissions (no scripts, no forms, no same-origin access), so the thumbnail can never drift from
 * the PDF and can never run anything. With no HTML it is a neutral card carrying the layout name.
 * It takes no pointer input and no focus: whatever holds it (a radio card, a dialog) owns the click.
 */
export function LayoutThumbnail({
  layout,
  html,
  decorative = false,
  className,
}: {
  layout: DocumentLayout;
  html: string | null;
  /** True where the surrounding control already names the layout, so a screen reader skips the frame. */
  decorative?: boolean | undefined;
  className?: string | undefined;
}) {
  const name = DOCUMENT_LAYOUT_LABELS[layout].name;
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(INITIAL_SCALE);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) setScale(width / PAGE_WIDTH);
    };
    measure();
    // jsdom and very old browsers have no ResizeObserver; the first measure still applies.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cls = [styles.thumb, className].filter(Boolean).join(' ');
  return (
    <div
      ref={frame}
      className={cls}
      data-state={html === null ? 'unavailable' : 'ready'}
      {...(decorative ? { 'aria-hidden': true } : {})}
    >
      {html === null ? (
        <div className={styles.thumbPlaceholder}>
          <span className={styles.thumbPlaceholderName}>{name}</span>
          <span>Preview unavailable</span>
        </div>
      ) : (
        <iframe
          title={`${name} layout, sample quotation`}
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          className={styles.thumbFrame}
          style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}
