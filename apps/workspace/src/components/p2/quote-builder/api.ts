import 'server-only';

import {
  type ContactDto,
  ContactDtoSchema,
  type CustomerDto,
  CustomerDtoSchema,
  type OpportunityDto,
  OpportunityDtoSchema,
  type QuotationDto,
  QuotationDtoSchema,
  type QuotationPreviewBody,
  type CreateQuotationBody,
  type UpdateQuotationDraftBody,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import {
  type PaymentTerm,
  PaymentTermSchema,
  PreviewResultSchema,
  type PreviewResult,
  SavedVersionSchema,
  type TaxCode,
  TaxCodeSchema,
} from './schemas';

/**
 * Calls from the workspace BFF to the quotation API. Server-only: every call carries the user's
 * access token. Every response is parsed with a schema, so an API that drifts fails here (502)
 * instead of painting `undefined` on the screen.
 *
 * The four write/preview paths are the ones in the brief. The read paths (`GET`) and the lookup
 * lists are assumptions the lead should confirm against the API when it lands.
 */

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

async function call<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(session, path, init);
  const body = await readBody(res);
  const label = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

const json = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** A list may arrive bare or as `{ items }`; the builder accepts both. */
const list = <T extends z.ZodType>(item: T) =>
  z.union([z.array(item), z.object({ items: z.array(item) }).transform((o) => o.items)]);

// ---- Writes and preview (paths from the brief) ----------------------------------------------

/** The API refuses a create without an Idempotency-Key (400); a retry with the same key returns the first answer. */
export function createQuotation(
  session: Session,
  body: CreateQuotationBody,
  idempotencyKey: string,
): Promise<QuotationDto> {
  return call(
    session,
    '/v1/quotations',
    QuotationDtoSchema,
    json('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}

export function updateDraft(
  session: Session,
  quotationId: string,
  versionId: string,
  body: UpdateQuotationDraftBody,
): Promise<{ version: number }> {
  return call(
    session,
    `/v1/quotations/${seg(quotationId)}/versions/${seg(versionId)}`,
    SavedVersionSchema,
    json('PUT', body),
  );
}

export function previewVersion(
  session: Session,
  quotationId: string,
  versionId: string,
  body: QuotationPreviewBody,
): Promise<PreviewResult> {
  return call(
    session,
    `/v1/quotations/${seg(quotationId)}/versions/${seg(versionId)}/preview`,
    PreviewResultSchema,
    json('POST', body),
  );
}

/**
 * Like create, submit needs an Idempotency-Key (400 without one). `approverUserId` names the one person who
 * decides the first approval step; without it every eligible approver of that step sees it.
 */
export function submitVersion(
  session: Session,
  quotationId: string,
  versionId: string,
  expectedVersion: number,
  idempotencyKey: string,
  approverUserId?: string,
): Promise<unknown> {
  return call(
    session,
    `/v1/quotations/${seg(quotationId)}/versions/${seg(versionId)}/submit`,
    z.unknown(),
    json(
      'POST',
      { expectedVersion, ...(approverUserId === undefined ? {} : { approverUserId }) },
      { 'idempotency-key': idempotencyKey },
    ),
  );
}

// ---- Reads (assumed paths) -------------------------------------------------------------------
// The quotation itself is read with `components/p2/quotations/api.ts` `getQuotation`, which parses
// the QuotationDetail that `GET /v1/quotations/:id` returns (parent plus every version).

export function getOpportunity(session: Session, id: string): Promise<OpportunityDto> {
  return call(session, `/v1/opportunities/${seg(id)}`, OpportunityDtoSchema);
}

export function getCustomer(session: Session, id: string): Promise<CustomerDto> {
  return call(session, `/v1/customers/${seg(id)}`, CustomerDtoSchema);
}

export function listContacts(session: Session, customerId: string): Promise<ContactDto[]> {
  return call(session, `/v1/customers/${seg(customerId)}/contacts`, list(ContactDtoSchema));
}

export function listTaxCodes(session: Session): Promise<TaxCode[]> {
  return call(session, '/v1/tax-codes', list(TaxCodeSchema));
}

export function listPaymentTerms(session: Session): Promise<PaymentTerm[]> {
  return call(session, '/v1/payment-terms', list(PaymentTermSchema));
}
