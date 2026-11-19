// Pure helpers for the PDF page viewer: zoom, fit-to-width, canvas size and which pages to
// render or announce. No DOM and no pdf.js here, so they are unit-tested without either.

/** Zoom is a multiplier over fit-to-width: 1 fits the page width to the viewer. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.25;
export const DEFAULT_ZOOM = 1;

/** Backing-store density is capped: a 3x phone screen would otherwise allocate 9 pixels per CSS pixel. */
export const MAX_DEVICE_PIXEL_RATIO = 2;
/** Mobile browsers refuse or silently blank canvases above roughly 16.7 million pixels (iOS Safari). */
export const MAX_CANVAS_PIXELS = 16_000_000;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** One zoom step in or out, rounded to hundredths so repeated steps never drift (0.1 + 0.2 style). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(Math.round((zoom + direction * ZOOM_STEP) * 100) / 100);
}

export function clampPage(page: number, pageCount: number): number {
  if (pageCount < 1 || !Number.isFinite(page)) return 1;
  return Math.min(pageCount, Math.max(1, Math.trunc(page)));
}

/** pdf.js scale that makes a page `pageWidth` units wide fill `availableWidth` CSS pixels, times zoom. */
export function pageScale(availableWidth: number, pageWidth: number, zoom: number): number {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 0;
  return (availableWidth / pageWidth) * clampZoom(zoom);
}

/**
 * Canvas pixels per CSS pixel: the device ratio, never above MAX_DEVICE_PIXEL_RATIO, and lowered
 * further until the whole canvas fits MAX_CANVAS_PIXELS. Never below 1.
 */
export function outputScale(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const ratio = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
  );
  const area = cssWidth * cssHeight;
  if (!(area > 0)) return Math.max(1, ratio);
  const budget = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(1, Math.min(ratio, budget));
}

/**
 * Pages (1-based, ascending) to keep rendered: every page the observer reports as near the
 * viewport, plus `buffer` pages on each side. Everything else is released to bound memory.
 */
export function pagesToRender(
  nearViewport: Iterable<number>,
  pageCount: number,
  buffer = 1,
): number[] {
  const wanted = new Set<number>();
  for (const page of nearViewport) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) continue;
    for (let n = page - buffer; n <= page + buffer; n += 1) {
      if (n >= 1 && n <= pageCount) wanted.add(n);
    }
  }
  return [...wanted].sort((a, b) => a - b);
}

export interface PageAtScrollInput {
  /** Top edge of each page inside the scroll content, in order. */
  tops: readonly number[];
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}

/**
 * The page the reader is on: the last page whose top is above a line one third down the viewport.
 * At the very bottom the last page wins, because a short last page can never reach that line.
 */
export function pageAtScroll({
  tops,
  scrollTop,
  viewportHeight,
  scrollHeight,
}: PageAtScrollInput): number {
  if (tops.length === 0) return 1;
  if (scrollHeight > viewportHeight && scrollTop + viewportHeight >= scrollHeight - 1) {
    return tops.length;
  }
  const line = scrollTop + viewportHeight / 3;
  let current = 1;
  for (let i = 0; i < tops.length; i += 1) {
    if ((tops[i] ?? 0) <= line) current = i + 1;
    else break;
  }
  return current;
}
