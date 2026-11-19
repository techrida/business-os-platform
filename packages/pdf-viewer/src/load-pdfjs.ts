// Loads pdf.js on the client only and points it at a worker served from our own origin.

export type PdfjsModule = typeof import('pdfjs-dist');

let cached: Promise<PdfjsModule> | null = null;

/**
 * Dynamic import, so the ~400 KB library stays out of every page bundle that does not open a PDF.
 *
 * Version and build are deliberate. The legacy build is used because it carries the polyfills
 * (Promise.withResolvers, Promise.try, Uint8Array.toHex and friends) that older iOS Safari and
 * Android WebViews lack. The pin is 4.5.136 because every legacy build from 4.6 on, including 5.x
 * and 6.x, contains an ES2022 class `static {}` block (Safari 16.4+) and would not even parse on
 * iOS Safari 15. See the pdfjs-dist note in pnpm-workspace.yaml before bumping it.
 *
 * `new URL('<package path>', import.meta.url)` makes the bundler (Turbopack or webpack) emit the
 * worker as a static asset under /_next/static, so it is same-origin and `worker-src 'self'`
 * covers it. No CDN and no blob: URL.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  cached ??= import('pdfjs-dist/legacy/build/pdf.mjs')
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      return pdfjs;
    })
    .catch((error: unknown) => {
      // A failed chunk load must not poison every later attempt.
      cached = null;
      throw error instanceof Error ? error : new Error('The PDF engine could not be loaded.');
    });
  return cached;
}
