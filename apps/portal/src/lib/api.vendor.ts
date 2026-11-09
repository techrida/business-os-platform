import 'server-only';

import {
  type SignedLinkDto,
  SignedLinkDtoSchema,
  VENDOR_VISIBLE_PO_STATUSES,
  type VendorPortalBillView,
  VendorPortalBillViewSchema,
  type VendorPortalOnboardingView,
  VendorPortalOnboardingViewSchema,
  type VendorPortalPurchaseOrderListItem,
  VendorPortalPurchaseOrderListItemSchema,
  type VendorPortalPurchaseOrderView,
  VendorPortalPurchaseOrderViewSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Server-to-server reads for the vendor portal (P4 PTV), over `/v1/portal/vendor`. Every view
 * schema is strict, so a field the vendor must not see (a review note, a match variance) fails
 * the parse as a 502 instead of reaching a page. The vendor's party comes from the token on the
 * API side; nothing here sends a party or vendor id.
 */

/** The same signed-link fetch the customer pages use: relative `/v1/files/<token>` paths only. */
export { openSignedFile as openVendorFile } from './api';

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function get<T>(session: Session, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** `GET /v1/portal/vendor/onboarding`: status, capability and the KYB checklist. */
export function getVendorOnboarding(session: Session): Promise<VendorPortalOnboardingView> {
  return get(session, '/v1/portal/vendor/onboarding', VendorPortalOnboardingViewSchema);
}

/** `GET /v1/portal/vendor/purchase-orders`: the vendor's own orders at their newest issued version. */
export function listVendorPurchaseOrders(
  session: Session,
): Promise<VendorPortalPurchaseOrderListItem[]> {
  return get(
    session,
    '/v1/portal/vendor/purchase-orders',
    z.array(VendorPortalPurchaseOrderListItemSchema),
  );
}

/** A body whose status is one a vendor may not see (a draft) is "not found", never a 502. */
const NotVisible = z
  .looseObject({ status: z.string() })
  .refine((b) => !(VENDOR_VISIBLE_PO_STATUSES as readonly string[]).includes(b.status));

const VisiblePo = z.unknown().transform((body, ctx) => {
  if (NotVisible.safeParse(body).success) {
    throw new ApiError(404, 'GET /v1/portal/vendor/purchase-orders/:id returned a hidden status');
  }
  const parsed = VendorPortalPurchaseOrderViewSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' });
    return z.NEVER;
  }
  return parsed.data;
});

/** `GET /v1/portal/vendor/purchase-orders/:id`. The API answers 404 for a foreign, draft or unknown id. */
export function getVendorPurchaseOrder(
  session: Session,
  id: string,
): Promise<VendorPortalPurchaseOrderView> {
  return get(session, `/v1/portal/vendor/purchase-orders/${seg(id)}`, VisiblePo);
}

/** `GET /v1/portal/vendor/purchase-orders/:id/pdf`: a short-lived signed link to the issued version's PDF. */
export function getVendorPurchaseOrderLink(session: Session, id: string): Promise<SignedLinkDto> {
  return get(session, `/v1/portal/vendor/purchase-orders/${seg(id)}/pdf`, SignedLinkDtoSchema);
}

/** `GET /v1/portal/vendor/bills`: the vendor's bills with the coarse status. */
export function listVendorBills(session: Session): Promise<VendorPortalBillView[]> {
  return get(session, '/v1/portal/vendor/bills', z.array(VendorPortalBillViewSchema));
}

/** `GET /v1/portal/vendor/bills/:id`. */
export function getVendorBill(session: Session, id: string): Promise<VendorPortalBillView> {
  return get(session, `/v1/portal/vendor/bills/${seg(id)}`, VendorPortalBillViewSchema);
}
