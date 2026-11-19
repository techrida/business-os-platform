export type PreviewKind = 'pdf' | 'image' | 'unsupported';

/** Raster image types a browser draws as pixels only. SVG is left out on purpose: it can carry script. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** `Application/PDF; charset=x` becomes `application/pdf`. */
export function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** Only PDF and raster images preview. Everything else, HTML and SVG included, gets the fallback. */
export function previewKind(mime: string): PreviewKind {
  const type = normalizeMime(mime);
  if (type === 'application/pdf') return 'pdf';
  if (IMAGE_TYPES.has(type)) return 'image';
  return 'unsupported';
}

/**
 * True for a URL that stays on `origin` over http(s). A path such as `/api/x` qualifies; `//evil.test/x`,
 * `\\evil.test`, `javascript:`, `data:` and `blob:` do not. The preview frame must never load active content
 * from anywhere else.
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
 * Hints for the browser's built-in PDF viewer: fit the whole page in the box, hide the thumbnail pane.
 * Chrome and Firefox honour them; a viewer that ignores them still shows the file.
 */
export function pdfViewerUrl(url: string): string {
  return url.includes('#') ? url : `${url}#view=Fit&navpanes=0`;
}

export type PreviewFetchOutcome =
  'ready' | 'preparing' | 'failed' | 'unavailable' | 'denied' | 'error';

/**
 * What an HTTP status from the preview route means for the viewer. 409 and 425 are "the PDF is still being prepared"
 * (the caller offers Retry), 424 is "preparing it failed", 404 and 410 are "there is no such PDF", 401 and 403 mean
 * the user lost access, anything else is a failure.
 */
export function previewFetchOutcome(status: number): PreviewFetchOutcome {
  if (status >= 200 && status < 300) return 'ready';
  if (status === 409 || status === 425) return 'preparing';
  if (status === 424) return 'failed';
  if (status === 404 || status === 410) return 'unavailable';
  if (status === 401 || status === 403) return 'denied';
  return 'error';
}
