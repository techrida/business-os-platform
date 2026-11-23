import 'server-only';

import {
  type AddressLines,
  type CountryCode,
  CountryCodeSchema,
  type CreateVendorBody,
  type DocumentVersionDto,
  DocumentVersionDtoSchema,
  PartyPhonesSchema,
  type ProposeBankAccountBody,
  type RejectBankAccountBody,
  type VendorAccountDto,
  VendorAccountDtoSchema,
  type VendorBankAccountDto,
  VendorBankAccountDtoSchema,
  type VendorContactBody,
  type VendorDto,
  VendorDtoSchema,
  type VendorKind,
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

/**
 * The API returns a contact as `VendorContactDto` (apps/api vendors.types.ts); contracts has the body only. `phones`
 * lists the primary first (FX9), with one primary and no number twice, as the body requires.
 */
export const VendorContactSchema = z.object({
  id: z.guid(),
  vendorPartyId: z.guid(),
  name: z.string(),
  email: z.string().nullable(),
  country: CountryCodeSchema,
  phones: PartyPhonesSchema,
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

/** A new contact: its own country, and each phone with its country (FX9). */
export type CreateVendorContact = VendorContactBody;

export interface UpdateVendorFields {
  expectedVersion: number;
  legalName?: string | undefined;
  /** D10: the kind and country change together (a foreign vendor is outside Nepal) until the vendor is approved. */
  kind?: VendorKind | undefined;
  country?: CountryCode | undefined;
  /** `null` clears the tax id of a foreign vendor. */
  pan?: string | null | undefined;
  /** Replaces the street lines and city; `null` clears them. */
  address?: AddressLines | null | undefined;
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

function withQuery(
  path: string,
  params: Record<string, string | number | readonly string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'object') {
      // A repeated filter: one key per value, which is how the API reads a multi-select.
      for (const item of value) if (item !== '') query.append(name, item);
    } else if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

// ------------------------------------------------------------------------------------- vendors

/**
 * `GET /v1/vendors?q=&status=&kind=&limit=&offset=` (needs `vendor.read`). Answers `{ items, total }`.
 * `status` and `kind` take one value or several (sent as repeated keys).
 */
export function listVendors(
  session: Session,
  query: {
    q?: string;
    status?: VendorStatus | readonly VendorStatus[];
    kind?: VendorDto['kind'] | readonly VendorDto['kind'][];
    limit?: number;
    offset?: number;
  },
): Promise<VendorList> {
  const many = <T extends string>(v: T | readonly T[] | undefined): T[] | undefined =>
    v === undefined ? undefined : typeof v === 'string' ? [v] : [...v];
  return call(
    session,
    withQuery('/v1/vendors', {
      q: query.q,
      status: many(query.status)?.map((s) => VendorStatusSchema.parse(s)),
      kind: many(query.kind),
      limit: query.limit,
      offset: query.offset,
    }),
    VendorListSchema,
  );
}

export function getVendor(session: Session, id: string): Promise<VendorDto> {
  return call(session, `/v1/vendors/${seg(id)}`, VendorDtoSchema);
}

const VendorNameMatchesSchema = z.strictObject({
  matches: z.array(
    z.strictObject({ id: z.guid(), legalName: z.string(), status: VendorStatusSchema }),
  ),
});
export type VendorNameMatch = z.infer<typeof VendorNameMatchesSchema>['matches'][number];

/**
 * `GET /v1/vendors/name-matches?legalName=`: the vendors whose legal name matches once case, spaces,
 * punctuation and company-form words are ignored. A warning for the add form; the API never refuses
 * a create for a name.
 */
export function findVendorNameMatches(
  session: Session,
  legalName: string,
): Promise<VendorNameMatch[]> {
  return call(
    session,
    withQuery('/v1/vendors/name-matches', { legalName }),
    VendorNameMatchesSchema,
  ).then((r) => r.matches);
}

const VendorReviewReadinessSchema = z.strictObject({ kybSubmitted: z.boolean() });

/**
 * `GET /v1/vendors/:id/review-readiness`: whether the vendor's KYB case is submitted (or approved), the
 * state the API checks before "Send for review" (pending_kyc -> under_review).
 */
export function getVendorReviewReadiness(
  session: Session,
  id: string,
): Promise<{ kybSubmitted: boolean }> {
  return call(session, `/v1/vendors/${seg(id)}/review-readiness`, VendorReviewReadinessSchema);
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

/**
 * `POST /v1/vendors/:id/submit-kyc`: draft to pending_kyc (opens the KYB case), then to under_review.
 * `expectedStatus` is the status the button was drawn for: the API answers 409 when the vendor has
 * moved on since, so a stale "Start KYB review" never sends the vendor for review.
 */
export function submitVendorKyc(
  session: Session,
  id: string,
  idempotencyKey: string,
  expectedStatus: VendorStatus,
): Promise<VendorDto> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/submit-kyc`,
    VendorDtoSchema,
    jsonInit('POST', { expectedStatus }, idempotencyKey),
  );
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

// ------------------------------------------------------------------- bank call-back evidence

const BankEvidenceCreatedSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: z.string(),
});
export type BankEvidenceCreated = z.infer<typeof BankEvidenceCreatedSchema>;

/** What the browser declares about the file. The account in the path owns it, so there is no owner field. */
export interface BankEvidenceFile {
  filename: string;
  declaredMime: string;
  sizeBytes: number;
}

/**
 * `POST /v1/vendors/:id/bank-accounts/:accountId/evidence` (needs `vendor.bank.propose`): step 1 of
 * the call-back evidence upload. Sends no Idempotency-Key, because the API takes none (a retry only
 * leaves an empty draft document). Answers 201 `{ documentId, versionId, uploadPath }`.
 */
export function createBankEvidence(
  session: Session,
  id: string,
  accountId: string,
  file: BankEvidenceFile,
): Promise<BankEvidenceCreated> {
  return call(
    session,
    `/v1/vendors/${seg(id)}/bank-accounts/${seg(accountId)}/evidence`,
    BankEvidenceCreatedSchema,
    jsonInit('POST', file),
  );
}

const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EVIDENCE_UPLOAD_PATH = new RegExp(
  `^/v1/vendors/(${UUID_PART})/bank-accounts/(${UUID_PART})/evidence/(${UUID_PART})/versions/(${UUID_PART})/content$`,
  'i',
);

/**
 * The content route the API hands back must be this vendor's, this account's and the ids it just
 * returned. Nothing is sent, and no token leaves, to any other path.
 */
function evidenceContentPath(id: string, accountId: string, created: BankEvidenceCreated): string {
  const match = EVIDENCE_UPLOAD_PATH.exec(created.uploadPath);
  const same = (a: string | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();
  if (
    match === null ||
    !same(match[1], id) ||
    !same(match[2], accountId) ||
    !same(match[3], created.documentId) ||
    !same(match[4], created.versionId)
  ) {
    throw new ApiError(502, 'POST bank-accounts evidence returned an unexpected uploadPath');
  }
  return created.uploadPath;
}

/**
 * Step 2: a raw `PUT` of the bytes to the `uploadPath` from `createBankEvidence`. The API requires
 * `Content-Length` (411 without it), so the browser's length is forwarded and the body is never
 * buffered here; `duplex: 'half'` is what Node's fetch demands for a streamed request body.
 */
export async function uploadBankEvidenceContent(
  session: Session,
  id: string,
  accountId: string,
  created: BankEvidenceCreated,
  upload: { body: ReadableStream<Uint8Array>; contentLength: number; contentType: string },
): Promise<DocumentVersionDto> {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: {
      // The file's own type: the API's JSON and form parsers only act on their own types and
      // would consume the stream otherwise.
      'content-type': upload.contentType,
      'content-length': String(upload.contentLength),
    },
    body: upload.body,
    duplex: 'half',
  };
  return call(session, evidenceContentPath(id, accountId, created), DocumentVersionDtoSchema, init);
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
