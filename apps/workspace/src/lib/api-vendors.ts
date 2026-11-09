import 'server-only';

import {
  type CreateVendorBody,
  type ProposeBankAccountBody,
  type RejectBankAccountBody,
  type VendorAccountDto,
  VendorAccountDtoSchema,
  type VendorBankAccountDto,
  VendorBankAccountDtoSchema,
  type VendorDto,
  VendorDtoSchema,
  type VendorStatus,
  VendorStatusSchema,
  type VerifyBankAccountBody,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the P4 vendor routes (`/v1/vendors`, its contacts, accounts
 * and bank accounts, and the portal grant). Server-only: every call carries the user's access
 * token. Each response is parsed with the contracts' schemas, so an API that drifts from the
 * contract fails here (502) instead of rendering `undefined`.
 *
 * Every POST takes the Idempotency-Key as a required argument (the API answers 400 without one), so
 * a missing key is a compile error. PATCH sends none: `expectedVersion` guards it.
 * Bank-account responses carry the last four characters only; nothing here can read a full number.
 */

export interface VendorList {
  items: VendorDto[];
  total: number;
}

const VendorListSchema = z.object({
  items: z.array(VendorDtoSchema),
  total: z.number().int().min(0),
});

/** The API returns a contact as `VendorContactDto` (apps/api vendors.types.ts); contracts has the body only. */
export const VendorContactSchema = z.object({
  id: z.guid(),
  vendorPartyId: z.guid(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(),
  isPrimary: z.boolean(),
  version: z.number().int().min(1),
});
export type VendorContact = z.infer<typeof VendorContactSchema>;

/** `POST /v1/vendors/:id/portal-access` answer (apps/api portal-access.types.ts). */
export const VendorPortalAccessSchema = z.object({
  vendorId: z.guid(),
  contactId: z.guid(),
  userId: z.guid(),
  idpOrgId: z.guid(),
  email: z.string(),
  status: z.enum(['invited', 'active', 'inactive']),
  inviteSent: z.boolean(),
  capability: z.string(),
});
export type VendorPortalAccess = z.infer<typeof VendorPortalAccessSchema>;

export type VendorLifecycleCommand = 'activate' | 'suspend' | 'block' | 'archive';

export interface CreateVendorContact {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  role?: string | undefined;
  isPortalAdmin: boolean;
}

export interface UpdateVendorFields {
  expectedVersion: number;
  legalName?: string | undefined;
  pan?: string | undefined;
  vatRegistered?: boolean | undefined;
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

function jsonInit(method: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  };
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

// ------------------------------------------------------------------------------------- vendors

/** `GET /v1/vendors?q=&status=&limit=&offset=` (needs `vendor.read`). Answers `{ items, total }`. */
export function listVendors(
  session: Session,
  query: { q?: string; status?: VendorStatus; limit?: number; offset?: number },
): Promise<VendorList> {
  return call(
    session,
    withQuery('/v1/vendors', {
      q: query.q,
      status: query.status !== undefined ? VendorStatusSchema.parse(query.status) : undefined,
      limit: query.limit,
      offset: query.offset,
    }),
    VendorListSchema,
  );
}

export function getVendor(session: Session, id: string): Promise<VendorDto> {
  return call(session, `/v1/vendors/${seg(id)}`, VendorDtoSchema);
}

/** `POST /v1/vendors` (needs `vendor.write`): a draft vendor. 409 `duplicate_pan_vat` for a PAN already held. */
export function createVendor(
  session: Session,
  body: CreateVendorBody,
  idempotencyKey: string,
): Promise<VendorDto> {
  return call(session, '/v1/vendors', VendorDtoSchema, jsonInit('POST', body, idempotencyKey));
}

/** `PATCH /v1/vendors/:id`. A stale `expectedVersion` is 409; a locked field on an approved vendor is 409. */
export function updateVendor(
  session: Session,
  id: string,
  body: UpdateVendorFields,
): Promise<VendorDto> {
  return call(session, `/v1/vendors/${seg(id)}`, VendorDtoSchema, jsonInit('PATCH', body));
}

/** `POST /v1/vendors/:id/submit-kyc`: draft to pending_kyc (opens the KYB case), then to under_review. */
export function submitVendorKyc(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<VendorDto> {
  return call(session, `/v1/vendors/${seg(id)}/submit-kyc`, VendorDtoSchema, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/**
 * `POST /v1/vendors/:id/{activate|suspend|block|archive}` (needs `vendor.activate`). Activate sends
 * no body; the others send the reason the audit trail keeps.
 */
export function vendorLifecycle(
  session: Session,
  id: string,
  command: VendorLifecycleCommand,
  idempotencyKey: string,
  reason?: string,
): Promise<VendorDto> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/${command}`,
    VendorDtoSchema,
    command === 'activate'
      ? { method: 'POST', headers: { 'idempotency-key': idempotencyKey } }
      : jsonInit('POST', { reason: reason ?? '' }, idempotencyKey),
  );
}

// ----------------------------------------------------------------------- contacts and accounts

/** `GET /v1/vendors/:id/contacts`: a bare array. */
export function listVendorContacts(session: Session, id: string): Promise<VendorContact[]> {
  return call(session, `/v1/vendors/${seg(id)}/contacts`, z.array(VendorContactSchema));
}

export function createVendorContact(
  session: Session,
  id: string,
  body: CreateVendorContact,
  idempotencyKey: string,
): Promise<VendorContact> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/contacts`,
    VendorContactSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `GET /v1/vendors/:id/accounts`: the vendor's terms with the acting legal entity. */
export function listVendorAccounts(session: Session, id: string): Promise<VendorAccountDto[]> {
  return call(session, `/v1/vendors/${seg(id)}/accounts`, z.array(VendorAccountDtoSchema));
}

// ------------------------------------------------------------------------------- bank accounts

/** `GET /v1/vendors/:id/bank-accounts`, newest first. The last four characters only. */
export function listBankAccounts(session: Session, id: string): Promise<VendorBankAccountDto[]> {
  return call(session, `/v1/vendors/${seg(id)}/bank-accounts`, z.array(VendorBankAccountDtoSchema));
}

/** `POST .../bank-accounts` (needs `vendor.bank.propose`). The API encrypts the number. */
export function proposeBankAccount(
  session: Session,
  id: string,
  body: ProposeBankAccountBody,
  idempotencyKey: string,
): Promise<VendorBankAccountDto> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/bank-accounts`,
    VendorBankAccountDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `POST .../bank-accounts/:accountId/verify` (needs `vendor.bank.verify`; 403 for the proposer). */
export function verifyBankAccount(
  session: Session,
  id: string,
  accountId: string,
  body: VerifyBankAccountBody,
  idempotencyKey: string,
): Promise<VendorBankAccountDto> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/bank-accounts/${seg(accountId)}/verify`,
    VendorBankAccountDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

export function rejectBankAccount(
  session: Session,
  id: string,
  accountId: string,
  body: RejectBankAccountBody,
  idempotencyKey: string,
): Promise<VendorBankAccountDto> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/bank-accounts/${seg(accountId)}/reject`,
    VendorBankAccountDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

// ---------------------------------------------------------------------------------- portal access

/** `POST /v1/vendors/:id/portal-access` (needs `vendor.write`): the contact becomes the portal admin. */
export function grantVendorPortalAccess(
  session: Session,
  id: string,
  contactId: string,
  idempotencyKey: string,
): Promise<VendorPortalAccess> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/portal-access`,
    VendorPortalAccessSchema,
    jsonInit('POST', { contactId }, idempotencyKey),
  );
}
