import { listCustomers } from '@/components/p2/customers/api';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { toCustomerOption } from '../customer-option';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How many matches one search lists; the person types more to narrow them. */
const SEARCH_LIMIT = 20;

/**
 * The Record payment customer picker's search (UIP-FORM-009): `GET /payments/new/customers?q=` answers
 * `{ customers }`, the live customers whose name, number or PAN/VAT match, as the signed-in user may read them (the
 * API scopes the list; the token never leaves the server). Only someone who may record payments can ask. A failure is
 * an error status the picker treats as "no more suggestions".
 */
export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  if (!(await getPermissionCheck(session))('payment.record')) {
    return jsonResponse(
      { error: { message: 'Your roles do not include recording payments.' } },
      403,
    );
  }
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 100);
  if (q === '') return jsonResponse({ customers: [] });
  try {
    const listing = await listCustomers(session, { q, limit: SEARCH_LIMIT });
    return jsonResponse({
      // A merged customer is not live: the record it was merged into is the one to pay.
      customers: listing.items.filter((c) => c.mergedIntoId === null).map(toCustomerOption),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
