import { IMAGE_MIME } from '@bos/contracts';

import { openPublicLogo } from '@/lib/api-branding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same cache contract as the API's public logo route: anyone (a browser, a mail client's image proxy) may keep it
 * for five minutes, and a removed logo is gone after that. Public, so a shared cache may hold it.
 */
const LOGO_CACHE = 'public, max-age=300';

const notFound = (): Response =>
  Response.json({ error: { message: 'Logo not found.' } }, { status: 404 });

/**
 * `GET /brand/logo/:tenantId`: the company's current logo with no session, as a same-origin proxy of the API's
 * public logo route. It exists so the header's `<img>` stays under the CSP `img-src 'self'` and so an email can name
 * an address on this app's own host. It answers an image of a known type or a 404, never anything else: whatever the
 * API says that is not the logo (an error, another type, an unreachable API) is the same 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<Response> {
  const { tenantId } = await params;
  if (!UUID.test(tenantId)) return notFound();

  let file: Response;
  try {
    file = await openPublicLogo(tenantId, request.headers.get('if-none-match') ?? undefined);
  } catch {
    return notFound();
  }
  const etag = file.headers.get('etag');

  if (file.status === 304) {
    void file.body?.cancel().catch(() => undefined);
    const headers = new Headers({ 'cache-control': LOGO_CACHE });
    if (etag !== null) headers.set('etag', etag);
    return new Response(null, { status: 304, headers });
  }

  const mime = (file.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (file.status !== 200 || !file.body || !(IMAGE_MIME as readonly string[]).includes(mime)) {
    void file.body?.cancel().catch(() => undefined);
    return notFound();
  }

  const headers = new Headers({
    'cache-control': LOGO_CACHE,
    'content-disposition': 'inline',
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  const length = file.headers.get('content-length');
  if (length !== null) headers.set('content-length', length);
  if (etag !== null) headers.set('etag', etag);
  return new Response(file.body, { status: 200, headers });
}
