import 'server-only';

import {
  ContactDtoSchema,
  CustomerActingEntitySchema,
  CustomerCanSchema,
  CustomerOwnerOptionSchema,
  CustomerPortalAccessSchema,
  CustomerDtoSchema,
  CustomerVerificationPresenceSchema,
  PartyAccountDtoSchema,
  PaymentTermSchema,
  type CustomerActingEntity,
  type CustomerCan,
  type CustomerOwnerOption,
  type CustomerPortalAccess,
  type CustomerVerificationPresence,
  type PersonName,
  PersonNameSchema,
  VerificationCaseDtoSchema,
  type ContactDto,
  type CreateContactBody,
  type CreateCustomerBody,
  type CustomerDto,
  type PartyAccountDto,
  type PaymentTerm,
  type ReviewVerificationBody,
  type UpdateCustomerBody,
  type UpdateCustomerTermsBody,
  type VerificationCaseDto,
  type VerificationStatus,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/**
 * Typed calls from the workspace BFF to the P2 customer and KYB routes. Server-only: every call
 * carries the user's access token. Each response is parsed with the contracts' schemas, so an API
 * that drifts from the contract fails here (502) instead of rendering `undefined`.
 *
 * The routes are on the API. The list envelope is not in the contracts, so a list may
 * come back as a bare array (like `/v1/approvals/inbox`) or as `{ items, total? }` (like the audit
 * log); both parse. Failures are worded by `failureOf` from `@/lib/api-kernel`.
 */

export interface Listing<T> {
  items: T[];
  /** The full count when the API sends it, so the page can say "of 41"; otherwise null. */
  total: number | null;
}

function listingOf<T extends z.ZodType>(item: T) {
  return z
    .union([
      z.array(item),
      z.object({ items: z.array(item), total: z.number().int().min(0).optional() }),
    ])
    .transform((body): Listing<z.infer<T>> =>
      Array.isArray(body)
        ? { items: body, total: null }
        : { items: body.items, total: body.total ?? null },
    );
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

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
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

function withQuery(
  path: string,
  params: Record<string, string | number | readonly string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'object') {
      // A repeated filter: one key per value, which is how the API reads a multi-select.
      for (const item of value) if (item !== '') query.append(key, item);
    } else if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

/**
 * `GET /v1/customers?q=&relationship=&industry=&limit=&offset=`. `q` is the search text (name, number,
 * PAN/VAT); `relationship` and `industry` repeat, one key per chosen value.
 */
export function listCustomers(
  session: Session,
  query: {
    q?: string;
    relationship?: readonly CustomerDto['relationship'][];
    industry?: readonly string[];
    limit?: number;
    offset?: number;
  },
): Promise<Listing<CustomerDto>> {
  return call(
    session,
    withQuery('/v1/customers', {
      q: query.q,
      relationship: query.relationship,
      industry: query.industry,
      limit: query.limit,
      offset: query.offset,
    }),
    listingOf(CustomerDtoSchema),
  );
}

export type RelationshipCounts = Record<CustomerDto['relationship'], number>;

/**
 * How many customers are in each relationship, for the list's cards: one filtered read of a single row per
 * relationship, so the numbers come from the same endpoint, filter and read scope as the list. `null` when
 * any read fails or the API sent no total, so a card never shows a guess.
 */
export async function countCustomersByRelationship(
  session: Session,
): Promise<RelationshipCounts | null> {
  try {
    const [prospect, active, inactive] = await Promise.all(
      (['prospect', 'active', 'inactive'] as const).map((relationship) =>
        listCustomers(session, { relationship: [relationship], limit: 1 }),
      ),
    );
    if (prospect?.total == null || active?.total == null || inactive?.total == null) return null;
    return { prospect: prospect.total, active: active.total, inactive: inactive.total };
  } catch {
    return null;
  }
}

/** `GET /v1/customers/industries`: the industries in use, for the list's Industry filter. */
export function listCustomerIndustries(session: Session): Promise<string[]> {
  return call(session, '/v1/customers/industries', z.array(z.string()));
}

export function getCustomer(session: Session, id: string): Promise<CustomerDto> {
  return call(session, `/v1/customers/${seg(id)}`, CustomerDtoSchema);
}

/**
 * A customer with its per-legal-entity terms. The contracts' `CustomerDto` has no `accounts`, so
 * the detail route is read as "the customer, plus an optional `accounts` array". `undefined` means
 * the API did not send terms; `[]` means it did and none are set. The two read differently.
 */
const CustomerDetailSchema = CustomerDtoSchema.extend({
  accounts: z.array(PartyAccountDtoSchema).optional(),
  /** The legal entity this person acts for: the one whose terms the Commercial terms card shows and saves. */
  actingEntity: CustomerActingEntitySchema.optional(),
  /** The account owner by name, sent with the record (staff only); older APIs leave it out. */
  people: z.array(PersonNameSchema).optional(),
  /** What this person may do with this customer, decided by the API on the record; absent reads as "nothing". */
  can: CustomerCanSchema.optional(),
  /** Whether the customer has a verification case, even one this person may not open. */
  verification: CustomerVerificationPresenceSchema.optional(),
  /** Whether the customer has a portal user and whether this person may invite one; absent reads as "no". */
  portalAccess: CustomerPortalAccessSchema.optional(),
});
export type CustomerDetail = CustomerDto & {
  accounts?: PartyAccountDto[] | undefined;
  actingEntity?: CustomerActingEntity | undefined;
  people?: PersonName[] | undefined;
  can?: CustomerCan | undefined;
  verification?: CustomerVerificationPresence | undefined;
  portalAccess?: CustomerPortalAccess | undefined;
};

/** The record's `can` flags, every one "no" when the API sent none. */
export function customerCan(customer: Pick<CustomerDetail, 'can'>): CustomerCan {
  return (
    customer.can ?? {
      write: false,
      readVerification: false,
      openVerification: false,
      creditLimit: false,
      owner: false,
      paymentTerms: false,
    }
  );
}

/** `GET /v1/customers/:id` with the optional `accounts` kept. */
export function getCustomerDetail(session: Session, id: string): Promise<CustomerDetail> {
  return call(session, `/v1/customers/${seg(id)}`, CustomerDetailSchema);
}

function jsonInit(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/**
 * `POST /v1/customers`. The key is required, as for approvals, so a double click or a retry after
 * a timeout cannot create the customer twice.
 */
export function createCustomer(
  session: Session,
  body: CreateCustomerBody,
  idempotencyKey: string,
): Promise<CustomerDto> {
  return call(
    session,
    '/v1/customers',
    CustomerDtoSchema,
    jsonInit('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}

/** `PATCH /v1/customers/:id`. `expectedVersion` makes a stale edit a 409, not a silent overwrite. */
export function updateCustomer(
  session: Session,
  id: string,
  body: UpdateCustomerBody,
): Promise<CustomerDto> {
  return call(session, `/v1/customers/${seg(id)}`, CustomerDtoSchema, jsonInit('PATCH', body));
}

/**
 * `GET /v1/customers/owners`: the active staff a customer's owner may be changed to, by name. Only for someone who
 * may change owners (`customers.owner.write`); 403 otherwise.
 */
export function listCustomerOwners(session: Session): Promise<CustomerOwnerOption[]> {
  return call(session, '/v1/customers/owners', z.array(CustomerOwnerOptionSchema));
}

/**
 * `GET /v1/customers/payment-terms`: the tenant's active payment terms, for the customer card's terms control and
 * labels. A customers route (`customer.read`), not the quotation one, so an editor without `quotation.read` keeps
 * the control.
 */
export function listCustomerPaymentTerms(session: Session): Promise<PaymentTerm[]> {
  return call(session, '/v1/customers/payment-terms', z.array(PaymentTermSchema));
}

/**
 * `PATCH /v1/customers/:id/terms`: the customer's payment term or credit limit with the acting entity. Send one
 * field; leave `expectedVersion` out only on the first save (no terms row yet).
 */
export function updateCustomerTerms(
  session: Session,
  id: string,
  body: UpdateCustomerTermsBody,
): Promise<PartyAccountDto> {
  return call(
    session,
    `/v1/customers/${seg(id)}/terms`,
    PartyAccountDtoSchema,
    jsonInit('PATCH', body),
  );
}

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

/** `GET /v1/customers/:id/contacts`. */
export function listContacts(session: Session, customerId: string): Promise<Listing<ContactDto>> {
  return call(session, `/v1/customers/${seg(customerId)}/contacts`, listingOf(ContactDtoSchema));
}

/** `POST /v1/customers/:id/contacts`. */
export function createContact(
  session: Session,
  customerId: string,
  body: CreateContactBody,
  idempotencyKey: string,
): Promise<ContactDto> {
  return call(
    session,
    `/v1/customers/${seg(customerId)}/contacts`,
    ContactDtoSchema,
    jsonInit('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}

// ---------------------------------------------------------------------------------------------
// Portal access (F1-Q31)
// ---------------------------------------------------------------------------------------------

/** `POST /v1/customers/:id/portal-access` answer (apps/api portal-access.types.ts PortalAccessDto). */
export const CustomerPortalGrantSchema = z.object({
  customerId: z.guid(),
  contactId: z.guid(),
  userId: z.guid(),
  idpOrgId: z.guid(),
  email: z.string(),
  status: z.enum(['invited', 'active', 'inactive']),
  inviteSent: z.boolean(),
});
export type CustomerPortalGrant = z.infer<typeof CustomerPortalGrantSchema>;

/**
 * `POST /v1/customers/:id/portal-access`: the contact becomes a portal admin and gets an invite. The body names an
 * existing contact of this customer, never an email; the first admin is invited by the account owner only.
 */
export function grantCustomerPortalAccess(
  session: Session,
  customerId: string,
  contactId: string,
  idempotencyKey: string,
): Promise<CustomerPortalGrant> {
  return call(
    session,
    `/v1/customers/${seg(customerId)}/portal-access`,
    CustomerPortalGrantSchema,
    jsonInit('POST', { contactId }, { 'idempotency-key': idempotencyKey }),
  );
}

// ---------------------------------------------------------------------------------------------
// Verification (KYB)
// ---------------------------------------------------------------------------------------------

/** `GET /v1/verification-cases?status=&partyId=`. */
export function listVerificationCases(
  session: Session,
  query: { status?: VerificationStatus; partyId?: string },
): Promise<Listing<VerificationCaseDto>> {
  return call(
    session,
    withQuery('/v1/verification-cases', { status: query.status, partyId: query.partyId }),
    listingOf(VerificationCaseDtoSchema),
  );
}

/**
 * `GET /v1/verification-cases` for the queue: one page and the full count from `X-Total-Count`
 * (the route answers a bare array). `status` and `partyKind` repeat.
 */
export async function listVerificationCasePage(
  session: Session,
  query: {
    q?: string;
    status?: readonly VerificationStatus[];
    partyKind?: readonly string[];
    limit?: number;
    offset?: number;
  },
): Promise<Listing<VerificationCaseDto>> {
  const path = withQuery('/v1/verification-cases', {
    q: query.q,
    status: query.status,
    partyKind: query.partyKind,
    limit: query.limit,
    offset: query.offset,
  });
  const res = await apiFetch(session, path);
  const body = await readBody(res);
  const label = 'GET /v1/verification-cases';
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = z.array(VerificationCaseDtoSchema).safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  return { items: parsed.data, total };
}

export function getVerificationCase(session: Session, id: string): Promise<VerificationCaseDto> {
  return call(session, `/v1/verification-cases/${seg(id)}`, VerificationCaseDtoSchema);
}

/**
 * `POST /v1/verification-cases/:id/decision`. The key is a required argument, as for approvals,
 * so a double click or a retry after a timeout cannot decide the case twice.
 */
export function decideVerification(
  session: Session,
  id: string,
  body: ReviewVerificationBody,
  idempotencyKey: string,
): Promise<VerificationCaseDto> {
  return call(session, `/v1/verification-cases/${seg(id)}/decision`, VerificationCaseDtoSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}
