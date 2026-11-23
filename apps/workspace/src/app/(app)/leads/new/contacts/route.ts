import { z } from 'zod';

import { listContacts } from '@/components/p2/customers/api';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

import type { LeadContactOption } from '../../_lib/customer-contacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The New lead contact field's list (BOS-UI-002): `GET /leads/new/contacts?customerId=` reads the customer's contacts
 * through `GET /v1/customers/:id/contacts` as the signed-in user and answers `{ contacts }`. The API decides who may
 * read the customer (a customer the user cannot read is a 404 there); the token never leaves the server.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const customerId = z.guid().safeParse(new URL(req.url).searchParams.get('customerId'));
  if (!customerId.success) {
    return jsonResponse({ error: { message: 'Choose a customer first.' } }, 400);
  }
  try {
    const result = await listContacts(session, customerId.data);
    const contacts: LeadContactOption[] = result.items.map((c) => ({
      id: c.id,
      name: c.fullName,
      detail: c.email ?? c.title,
    }));
    return jsonResponse({ contacts });
  } catch (err) {
    return errorResponse(err);
  }
}
