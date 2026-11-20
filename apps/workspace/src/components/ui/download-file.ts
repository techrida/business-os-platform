// Downloads a file from a same-origin route without leaving the page (round 4, R4c2: TR-Q4). A plain link navigates
// the tab, so a refusal (the PDF is still being prepared, the session ended) replaced the app with a bare error page.
// This fetches the route once, and only a successful answer of the expected type becomes a file the browser saves; any
// other answer becomes a message the caller shows in the app. The routes answer a refusal as one short plain-text
// sentence written for a person (signed-file-route.ts), so that sentence is shown; anything else gets a fixed one.
// One request per click: the routes issue a single-use signed link on every call.
import { normalizeMime } from './file-preview-model';

export type DownloadOutcome = { ok: true } | { ok: false; message: string };

const FALLBACK_MESSAGE = 'The file could not be downloaded.';
const NETWORK_MESSAGE = 'The download did not start. Check your connection and try again.';
/** A refusal longer than this is not one of the routes' sentences, so it is not shown. */
const MAX_MESSAGE_LENGTH = 200;

/** The file name of a `Content-Disposition` header (`filename*=UTF-8''…` first, then `filename="…"`), or null. */
export function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return cleanName(decodeURIComponent(extended[1].trim()));
    } catch {
      // A malformed escape: fall back to the plain name.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  const name = plain?.[1] ?? plain?.[2];
  return name === undefined ? null : cleanName(name.trim());
}

/** No folders in a saved name. Empty becomes null so the caller's name is used. */
function cleanName(name: string): string | null {
  const base = name.replace(/[/\\]/g, '-').trim();
  return base === '' ? null : base;
}

async function refusalMessage(response: Response): Promise<string> {
  if (normalizeMime(response.headers.get('content-type') ?? '') !== 'text/plain') {
    await response.body?.cancel();
    return FALLBACK_MESSAGE;
  }
  const text = (await response.text()).trim();
  return text !== '' && text.length <= MAX_MESSAGE_LENGTH ? text : FALLBACK_MESSAGE;
}

/**
 * Fetches `url` (same origin, the user's own cookies, no cache) and saves the answer as `name`, or as the name the
 * route's Content-Disposition gives. `expectType` (for example `application/pdf`) refuses an answer of any other type.
 */
export async function downloadFile(
  url: string,
  name: string,
  options: { expectType?: string } = {},
): Promise<DownloadOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
  if (!response.ok) return { ok: false, message: await refusalMessage(response) };
  const type = normalizeMime(response.headers.get('content-type') ?? '');
  if (options.expectType !== undefined && type !== options.expectType) {
    await response.body?.cancel();
    return { ok: false, message: FALLBACK_MESSAGE };
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filenameFromDisposition(response.headers.get('content-disposition')) ?? name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The browser reads the object URL after the click returns; free it once the save has had time to start.
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
  return { ok: true };
}
