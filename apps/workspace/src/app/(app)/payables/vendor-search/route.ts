import { listVendors } from '@/lib/api-vendors';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { VENDOR_SEARCH_LIMIT, vendorOption } from '../_lib/vendor-options';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The vendors whose name or tax id matches `?q=`, for the vendor picker of a new bill when there are more vendors
 * than the page loads. Same grant as the new-bill page. A GET that reads only what the page already lists.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  if (!hasGrant(await getGrants(session), 'payables.bill.enter'))
    return jsonResponse({ error: { message: 'Your roles do not allow keying in bills.' } }, 403);
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 200);
  if (q === '') return jsonResponse({ vendors: [] });
  try {
    const result = await listVendors(session, { limit: VENDOR_SEARCH_LIMIT, offset: 0, q });
    return jsonResponse({ vendors: result.items.map(vendorOption) });
  } catch (err) {
    return errorResponse(err);
  }
}
