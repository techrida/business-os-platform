// The apps' own tsc runs over this source (bos-source), so the CSS import must type-check there too.
// A triple-slash directive is only honoured before the first statement, hence above 'use client'.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css.d.ts" />
'use client';

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import './pdf-pages.css';
import { loadPdfjs } from './load-pdfjs';
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPage,
  outputScale,
  pageAtScroll,
  pageScale,
  pagesToRender,
  stepZoom,
} from './viewer-math';

/** Must equal the horizontal padding of `.pdf-pages__scroller` in pdf-pages.css. */
const GUTTER = 8;
/** Pages this far outside the scrollport (as a share of its height) count as near and get rendered. */
const NEAR_VIEWPORT_MARGIN = '60% 0px';

export interface PdfPagesProps {
  /**
   * The PDF bytes. Keep the reference stable between renders (hold it in state or a memo): a new
   * reference reloads the document. The viewer copies the bytes, so the caller's buffer is never
   * detached by pdf.js.
   */
  data: Uint8Array | ArrayBuffer;
  /** Accessible name of the document region. */
  title: string;
  onError?: ((error: Error) => void) | undefined;
  className?: string | undefined;
}

interface PageSize {
  width: number;
  height: number;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; doc: PDFDocumentProxy; sizes: PageSize[] };

interface ActiveRender {
  key: string;
  /** Set once pdf.js has started; null while the page is still being fetched. */
  task: RenderTask | null;
  cancelled: boolean;
}

function cancelRender(entry: ActiveRender) {
  entry.cancelled = true;
  entry.task?.cancel();
}

/** Above this many pages only the first page is measured; the rest are assumed to match it. */
const MAX_MEASURED_PAGES = 300;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('The PDF could not be displayed.');
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

function copyBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : data.slice();
}

function releaseCanvas(container: HTMLElement | undefined) {
  if (!container) return;
  for (const canvas of container.querySelectorAll('canvas')) {
    // Safari keeps the backing store of a detached canvas alive until its size is reset.
    canvas.width = 0;
    canvas.height = 0;
  }
  container.replaceChildren();
}

/**
 * Renders a PDF from bytes to canvases with pdf.js, one canvas per page near the viewport.
 * Canvas only: there is no text layer, so text is not selectable and not announced. Bytes only,
 * never a URL, so the caller keeps control of authorisation and scanning.
 */
export function PdfPages({ data, title, onError, className }: PdfPagesProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([1, 2]));

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renders = useRef(new Map<number, ActiveRender>());
  const scrollRatio = useRef(0);
  const pageCountRef = useRef(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const fail = useCallback((error: unknown) => {
    setPhase({ kind: 'error' });
    onErrorRef.current?.(toError(error));
  }, []);

  // Load the document; destroy it (and its worker) on unmount or when the bytes change.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    setPhase({ kind: 'loading' });
    pageCountRef.current = 0;
    scrollRatio.current = 0;
    pageRefs.current = [];
    setPage(1);
    setNear(new Set([1, 2]));
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // pdf.js transfers the buffer to its worker, so it gets a copy. isEvalSupported stays
        // off: the CSP has no 'unsafe-eval' in production and pdf.js would only log violations.
        task = pdfjs.getDocument({ data: copyBytes(data), isEvalSupported: false });
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        const measured = Math.min(doc.numPages, MAX_MEASURED_PAGES);
        const sizes: PageSize[] = [];
        for (let n = 1; n <= measured; n += 1) {
          const view = (await doc.getPage(n)).getViewport({ scale: 1 });
          if (cancelled) return;
          sizes.push({ width: view.width, height: view.height });
        }
        const last = sizes[sizes.length - 1];
        while (last && sizes.length < doc.numPages) sizes.push(last);
        if (sizes.length === 0) throw new Error('The PDF has no pages.');
        setPhase({ kind: 'ready', doc, sizes });
      } catch (error) {
        if (!cancelled) fail(error);
      }
    })();
    return () => {
      cancelled = true;
      if (task) void task.destroy();
    };
  }, [data, fail]);

  const ready = phase.kind === 'ready' ? phase : null;
  const failed = phase.kind === 'error';
  const pageCount = ready?.sizes.length ?? 0;
  const available = Math.max(0, width - 2 * GUTTER);
  useEffect(() => {
    pageCountRef.current = pageCount;
  });

  // Fit width: follow the scroller's width (rotation, window resize, sidebar toggles).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const measure = () => setWidth(scroller.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [failed]);

  // Keep the reader at the same relative position when zoom or width change the page heights.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scrollRatio.current * scroller.scrollHeight;
  }, [zoom, width]);

  // Report which pages are near the scrollport.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!ready || !scroller || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) seen.add(n);
          else seen.delete(n);
        }
        setNear(new Set(seen));
      },
      { root: scroller, rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    for (const el of pageRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  // Render pages near the viewport, release the rest, cancel in-flight work when it is stale.
  useEffect(() => {
    if (!ready || available <= 0) return;
    const active = renders.current;
    const wanted = new Set(pagesToRender(near, pageCount));
    const ratio = window.devicePixelRatio || 1;

    for (const [n, entry] of active) {
      if (wanted.has(n)) continue;
      cancelRender(entry);
      active.delete(n);
      releaseCanvas(pageRefs.current[n - 1] ?? undefined);
    }

    for (const n of wanted) {
      const size = ready.sizes[n - 1];
      const box = pageRefs.current[n - 1];
      if (!size || !box) continue;
      const scale = pageScale(available, size.width, zoom);
      const key = `${scale.toFixed(4)}|${ratio}`;
      const current = active.get(n);
      if (current?.key === key) continue;
      if (current) cancelRender(current);
      // Registered before the first await, so a second pass sees and cancels it.
      const entry: ActiveRender = { key, task: null, cancelled: false };
      active.set(n, entry);
      void renderPage(ready.doc, n, scale, ratio, entry, box, fail);
    }
  }, [ready, available, zoom, near, pageCount, fail]);

  // Cancel every render when the document changes or the viewer unmounts.
  useEffect(() => {
    const active = renders.current;
    const boxes = pageRefs.current;
    return () => {
      for (const [n, entry] of active) {
        cancelRender(entry);
        releaseCanvas(boxes[n - 1] ?? undefined);
      }
      active.clear();
    };
  }, [ready]);

  const goToPage = useCallback(
    (target: number) => {
      const next = clampPage(target, pageCount);
      const scroller = scrollerRef.current;
      const box = pageRefs.current[next - 1];
      if (scroller && box) scroller.scrollTop = Math.max(0, box.offsetTop - GUTTER);
      setPage(next);
    },
    [pageCount],
  );

  const changeZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => stepZoom(current, direction));
  }, []);

  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      scrollRatio.current =
        scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
      setPage(
        pageAtScroll({
          // Only the current document's pages: after a data change the array may be longer.
          tops: Array.from(
            { length: pageCountRef.current },
            (_, i) => pageRefs.current[i]?.offsetTop ?? 0,
          ),
          scrollTop: scroller.scrollTop,
          viewportHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
        }),
      );
    });
  }, []);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return;
    const scroller = scrollerRef.current;
    const scrollsSideways = !!scroller && scroller.scrollWidth > scroller.clientWidth + 1;
    switch (event.key) {
      case 'PageDown':
      case 'ArrowRight':
        // When zoomed past the width, the arrows keep their native sideways scroll.
        if (event.key === 'ArrowRight' && scrollsSideways) return;
        event.preventDefault();
        goToPage(page + 1);
        return;
      case 'PageUp':
      case 'ArrowLeft':
        if (event.key === 'ArrowLeft' && scrollsSideways) return;
        event.preventDefault();
        goToPage(page - 1);
        return;
      case '+':
      case '=':
        event.preventDefault();
        changeZoom(1);
        return;
      case '-':
      case '_':
        event.preventDefault();
        changeZoom(-1);
        return;
      default:
    }
  };

  const classes = className ? `pdf-pages ${className}` : 'pdf-pages';

  if (phase.kind === 'error') {
    return (
      <div className={classes}>
        <p className="pdf-pages__message" role="alert">
          This document could not be displayed.
        </p>
      </div>
    );
  }

  return (
    <div className={classes} onKeyDown={onKeyDown}>
      <div className="pdf-pages__toolbar" role="toolbar" aria-label="Document controls">
        <button
          type="button"
          className="pdf-pages__button"
          aria-label="Previous page"
          disabled={!ready || page <= 1}
          onClick={() => goToPage(page - 1)}
        >
          Prev
        </button>
        <button
          type="button"
          className="pdf-pages__button"
          aria-label="Next page"
          disabled={!ready || page >= pageCount}
          onClick={() => goToPage(page + 1)}
        >
          Next
        </button>
        <span className="pdf-pages__status">{ready ? `Page ${page} of ${pageCount}` : ''}</span>
        <button
          type="button"
          className="pdf-pages__button pdf-pages__button--icon"
          aria-label="Zoom out"
          disabled={!ready || zoom <= MIN_ZOOM}
          onClick={() => changeZoom(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="pdf-pages__button"
          aria-label="Fit to width"
          disabled={!ready || zoom === DEFAULT_ZOOM}
          onClick={() => setZoom(DEFAULT_ZOOM)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="pdf-pages__button pdf-pages__button--icon"
          aria-label="Zoom in"
          disabled={!ready || zoom >= MAX_ZOOM}
          onClick={() => changeZoom(1)}
        >
          +
        </button>
      </div>
      <div
        ref={scrollerRef}
        className="pdf-pages__scroller"
        role="document"
        aria-label={title}
        aria-busy={!ready}
        tabIndex={0}
        onScroll={onScroll}
      >
        {ready ? (
          <div className="pdf-pages__pages">
            {ready.sizes.map((size, index) => {
              const scale = pageScale(available, size.width, zoom);
              return (
                <div
                  key={index}
                  ref={(el) => {
                    pageRefs.current[index] = el;
                  }}
                  className="pdf-pages__page"
                  data-page={index + 1}
                  style={{ width: size.width * scale, height: size.height * scale }}
                />
              );
            })}
          </div>
        ) : (
          <p className="pdf-pages__message" role="status">
            Loading…
          </p>
        )}
      </div>
      <div className="pdf-pages__live" role="status" aria-live="polite">
        {ready ? `Page ${page} of ${pageCount}` : ''}
      </div>
    </div>
  );
}

async function renderPage(
  doc: PDFDocumentProxy,
  n: number,
  scale: number,
  devicePixelRatio: number,
  entry: ActiveRender,
  box: HTMLElement,
  fail: (error: unknown) => void,
): Promise<void> {
  try {
    const pdfPage = await doc.getPage(n);
    if (entry.cancelled) return;
    const base = pdfPage.getViewport({ scale });
    const density = outputScale(base.width, base.height, devicePixelRatio);
    const viewport = pdfPage.getViewport({ scale: scale * density });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) throw new Error('A canvas is not available.');
    entry.task = pdfPage.render({ canvasContext, viewport });
    await entry.task.promise;
    if (entry.cancelled) return;
    // Swap in the finished canvas only now: the previous one stays visible until then.
    releaseCanvas(box);
    box.replaceChildren(canvas);
  } catch (error) {
    if (!entry.cancelled && !isCancelled(error)) fail(error);
  }
}
