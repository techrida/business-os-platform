// Browser side of "Download PDF" and "Print": the PDF is fetched as real bytes and saved, and printing clones only
// the memo paper into a hidden frame, so the form, sidebar and header can never end up on the page.
import type { MemoPdfInput } from '@/lib/memo-pdf-input';

export type PdfSource = { kind: 'saved'; memoId: string } | { kind: 'draft'; input: MemoPdfInput };

export interface PdfOutcome {
  ok: boolean;
  message: string;
}

/** The file name the server sent, else a safe default. */
export function fileNameFrom(header: string | null, fallback = 'memo.pdf'): string {
  const match = header && /filename="?([A-Za-z0-9._-]{1,120})"?/.exec(header);
  return match ? match[1]! : fallback;
}

/** Fetches the memo as a PDF and hands it to the browser's own save flow. Nothing leaves the workspace origin. */
export async function downloadMemoPdf(source: PdfSource): Promise<PdfOutcome> {
  let res: Response;
  try {
    res =
      source.kind === 'saved'
        ? await fetch(`/api/memos/${encodeURIComponent(source.memoId)}/pdf`, { cache: 'no-store' })
        : await fetch('/api/memos/pdf', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(source.input),
          });
  } catch {
    return {
      ok: false,
      message: 'The PDF could not be made. Check your connection and try again.',
    };
  }
  if (res.status === 401) {
    // /auth/login is a Route Handler, not a page: it needs a real navigation.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
    return { ok: false, message: 'Your session ended. Signing you in again.' };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, message: data.error?.message ?? 'The PDF could not be made. Try again.' };
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileNameFrom(res.headers.get('content-disposition'));
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the browser has taken the file; the delay only covers slow starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const replaced = Number(res.headers.get('x-memo-pdf-substituted') ?? '0');
  return {
    ok: true,
    message:
      replaced > 0
        ? `PDF downloaded. ${replaced} character${replaced === 1 ? '' : 's'} the PDF fonts cannot draw (for example CJK or emoji) ${replaced === 1 ? 'was' : 'were'} replaced with "?".`
        : 'PDF downloaded.',
  };
}

/** Print rules for the cloned paper: A4, no frame, black on white, nothing but the paper. */
export const PRINT_CSS = `
  @page { size: A4; margin: 16mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  [data-memo-paper] { border: 0 !important; padding: 0 !important; width: auto !important;
    max-width: none !important; background: #fff !important; color: #000 !important;
    box-shadow: none !important; position: static !important; max-height: none !important; overflow: visible !important; }
  [data-memo-paper] * { color: inherit; }
`;

const loaded = (link: HTMLLinkElement): Promise<void> =>
  new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    window.setTimeout(resolve, 3000);
  });

/**
 * Prints one element. The element is cloned, with the page's stylesheets, into an off-screen same-origin frame and
 * only that frame is printed, so the surrounding form and app shell are not on the page. Resolves false when the
 * element is missing or the browser refuses the frame.
 */
export async function printMemoPaper(elementId: string): Promise<boolean> {
  const source = document.getElementById(elementId);
  if (!source) return false;
  const frame = document.createElement('iframe');
  frame.setAttribute('data-memo-print-frame', '');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Memo print preview';
  frame.tabIndex = -1;
  frame.style.cssText =
    'position:fixed;inset-block-start:0;inset-inline-start:-10000px;width:210mm;height:297mm;border:0;visibility:hidden';
  document.body.append(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return false;
  }
  doc.open();
  doc.write(
    `<!doctype html><html lang="${document.documentElement.lang || 'en'}"><head><meta charset="utf-8"><title>Memo</title></head><body></body></html>`,
  );
  doc.close();
  const links: HTMLLinkElement[] = [];
  for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = node.cloneNode(true) as HTMLElement;
    doc.head.append(copy);
    if (copy instanceof HTMLLinkElement) links.push(copy);
  }
  const rules = doc.createElement('style');
  rules.textContent = PRINT_CSS;
  doc.head.append(rules);
  const paper = source.cloneNode(true) as HTMLElement;
  paper.removeAttribute('id');
  doc.body.append(paper);
  await Promise.all(links.map(loaded));
  await doc.fonts?.ready.catch(() => undefined);

  const cleanup = () => frame.remove();
  win.addEventListener('afterprint', cleanup, { once: true });
  // Some browsers never fire afterprint (dialog dismissed in a headless run): do not leave the frame behind.
  window.setTimeout(cleanup, 120_000);
  win.focus();
  win.print();
  return true;
}
