import { PARTY_IMPORT_MAX_BYTES } from '@bos/contracts';

import { importFailureMessage, previewImport } from '@/lib/api-imports';
import { forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';

import { IMPORT_KINDS, importSlugOf } from '../../_lib/import-view';

export const dynamic = 'force-dynamic';

/** Room for the multipart boundaries and part headers around one file of at most the import limit. */
const MAX_BODY = PARTY_IMPORT_MAX_BYTES + 16_384;
const TOO_LARGE = 'The file is larger than 2 MB. Split it and upload the parts one by one.';

/** Reads the body up to `max` bytes. Null when it is longer, so a lying Content-Length cannot buy memory. */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Sends the person back to the upload page with the reason, which the page shows as an alert. */
const back = (slug: string, message: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/imports/${slug}?${new URLSearchParams({ error: message.slice(0, 300) })}`,
      'cache-control': 'no-store',
    },
  });

/**
 * `POST /imports/:kind/upload`: the upload form's target. Route handlers get no origin check from Next, so the Origin
 * is checked first. The file is read here with its size capped, handed to the API as raw bytes (the API checks the
 * encoding, the header and every row, and the grant to import that kind) and the person is sent on to the preview.
 * Nothing is kept in the workspace: no file on disk, no bucket.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const slug = importSlugOf((await params).kind);
  if (slug === null)
    return jsonResponse({ error: { message: 'There is no import of that kind.' } }, 404);

  const contentType = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType))
    return back(slug, 'Send the file as a file upload.');
  const length = req.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BODY) return back(slug, TOO_LARGE);
  const raw = await readBounded(req, MAX_BODY);
  if (raw === null) return back(slug, TOO_LARGE);
  let file: FormDataEntryValue | null;
  try {
    const form = await new Response(raw as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': contentType },
    }).formData();
    file = form.get('file');
  } catch {
    return back(slug, 'The upload could not be read.');
  }
  if (!(file instanceof File) || file.size === 0) return back(slug, 'Choose a CSV file to upload.');
  if (file.size > PARTY_IMPORT_MAX_BYTES) return back(slug, TOO_LARGE);

  try {
    const batch = await previewImport(
      session,
      IMPORT_KINDS[slug].kind,
      file.name || 'import.csv',
      await file.arrayBuffer(),
    );
    return new Response(null, {
      status: 303,
      headers: { location: `/imports/result/${batch.id}`, 'cache-control': 'no-store' },
    });
  } catch (err) {
    return back(slug, importFailureMessage(err));
  }
}
