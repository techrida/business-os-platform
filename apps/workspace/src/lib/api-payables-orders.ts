import 'server-only';

import { PoStatusSchema } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * The purchase order pickers of the payables forms (apps/api vendor-orders.controller.ts): the orders a
 * bill can be entered against (`payables.bill.enter`) and the orders a payment request can name
 * (`payables.payment.request`). Neither needs a purchase order read. Strict: the API sends only what
 * the picker shows, and a field it starts sending fails here (502) instead of leaking into a screen.
 */

export const VendorOrderOptionSchema = z.strictObject({
  id: z.guid(),
  number: z.string(),
  status: PoStatusSchema,
  vendorId: z.guid(),
});
export type VendorOrderOption = z.infer<typeof VendorOrderOptionSchema>;

/** At most this many orders are offered; the screens say so when the list is full. */
export const ORDER_PICKER_LIMIT = 200;

async function options(session: Session, path: string): Promise<VendorOrderOption[]> {
  const res = await apiFetch(session, `${path}?limit=${ORDER_PICKER_LIMIT}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  const label = `GET ${path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = z.array(VendorOrderOptionSchema).safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** The entity's orders a bill can be entered against, newest issued first. */
export function listBillableOrders(session: Session): Promise<VendorOrderOption[]> {
  return options(session, '/v1/payables/billable-orders');
}

/** The entity's orders a payment request can name, newest issued first. */
export function listPaymentRequestOrders(session: Session): Promise<VendorOrderOption[]> {
  return options(session, '/v1/payables/payment-request-orders');
}
