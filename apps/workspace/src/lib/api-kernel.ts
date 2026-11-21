import 'server-only';

import {
  type ApprovalActionBody,
  type ApprovalRequestDto,
  ApprovalRequestDtoSchema,
  ApprovalRequestStatusSchema,
  type AuditEventDto,
  AuditEventDtoSchema,
  type CreateDocumentBody,
  type CreateMemoBody,
  DocumentVersionDtoSchema,
  ErrorBodySchema,
  type InboxItemDto,
  InboxCountDtoSchema,
  InboxItemDtoSchema,
  type MemoList,
  MemoListSchema,
  MemoApproverRuleSchema,
  MemoDtoSchema,
  MemoDirectorySchema,
  type NotificationDto,
  NotificationDtoSchema,
  type RoutePlan,
  RoutePlanSchema,
  type SignedLinkDto,
  SignedLinkDtoSchema,
  type UnreadCountDto,
  UnreadCountDtoSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { DocumentSchema, type DocumentDetail } from '@/components/p2/crm/verification-file';

import { ApiError, apiFetch } from './api';
import type { EvidenceKind } from './evidence';
import { describeFailure, type Failure, type FailureContext } from './kernel-ui';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the kernel's API routes (approvals, test memos, documents,
 * notifications, audit). Server-only: every call carries the user's access token.
 *
 * Every response is parsed with the contracts' Zod schemas, so an API that drifts from the contract
 * fails loudly here (502) instead of rendering `undefined` on a screen. Serves the NFR "the UI
 * never shows data the contract does not promise".
 */

// ---------------------------------------------------------------------------------------------
// Shapes that live in the API module rather than in @bos/contracts (see test-memo.types.ts)
// ---------------------------------------------------------------------------------------------

export const MemoDetailSchema = MemoDtoSchema.extend({
  canUpdate: z.boolean().default(false),
  attachments: z.array(DocumentVersionDtoSchema),
  approval: z.object({ requestId: z.string(), status: ApprovalRequestStatusSchema }).nullable(),
  /** Who may sign "Approved by" on this memo (F1-Q9); sent to whoever may edit a template memo. */
  approverRule: MemoApproverRuleSchema.optional(),
});
export type MemoDetail = z.infer<typeof MemoDetailSchema>;
export type Memo = z.infer<typeof MemoDtoSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionDtoSchema>;

const SubmitMemoResultSchema = z.object({
  requestId: z.string(),
  status: z.enum(['pending', 'blocked']),
});
export type SubmitMemoResult = z.infer<typeof SubmitMemoResultSchema>;

const CreatedDocumentSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: z.string(),
});
export type CreatedDocument = z.infer<typeof CreatedDocumentSchema>;

const AuditListSchema = z.object({ items: z.array(AuditEventDtoSchema) });

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

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

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/**
 * The API's own sentence for a refusal, or undefined when the body is not the standard error shape.
 * `failureOf` leaves this out for a 409, so a caller that must tell two 409s apart reads it here.
 * Match it against known wording; do not show it as it is.
 */
export function apiMessageOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success ? parsed.data.error.message : undefined;
}

/**
 * Turns any thrown value into something a screen can show. A thrown non-`ApiError` (the fetch
 * itself failed: API down, DNS, timeout) becomes status 0, which `describeFailure` words as
 * "the platform did not respond" and marks as not definite.
 */
export function failureOf(
  err: unknown,
  context: FailureContext = 'generic',
): Failure & {
  status: number;
} {
  if (!(err instanceof ApiError)) return { ...describeFailure({ status: 0 }, context), status: 0 };
  const parsed = ErrorBodySchema.safeParse(err.body);
  const error = parsed.success ? parsed.data.error : undefined;
  const failure = describeFailure(
    {
      status: err.status,
      code: error?.code,
      reason: error?.reason,
      // The API's 400 text names fields, never values (see its controllers), so it is safe to show.
      detail: err.status === 400 ? error?.message : undefined,
    },
    context,
  );
  return { ...failure, status: err.status };
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

/**
 * `GET /v1/approvals/inbox`: a bare array of what waits on the caller. Approvers see their steps; a Sales user
 * sees only a quotation step the author named them for (else an empty list); other staff may get 403.
 */
export function getInbox(session: Session): Promise<InboxItemDto[]> {
  return call(session, '/v1/approvals/inbox', z.array(InboxItemDtoSchema));
}

export type InboxPage = { items: InboxItemDto[]; total: number };

/**
 * `GET /v1/approvals/inbox` with filters and a window. The body is the same bare array; `X-Total-Count` is how many
 * the caller may decide that match, so the page count never comes from the rows shown.
 */
export async function getInboxPage(
  session: Session,
  opts: { q?: string; documentType?: readonly string[]; limit?: number; offset?: number } = {},
): Promise<InboxPage> {
  const query = new URLSearchParams();
  if (opts.q) query.set('q', opts.q);
  for (const type of opts.documentType ?? []) query.append('documentType', type);
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  if (opts.offset) query.set('offset', String(opts.offset));
  const qs = query.toString();
  const path = `/v1/approvals/inbox${qs === '' ? '' : `?${qs}`}`;
  const res = await apiFetch(session, path);
  const body = await readBody(res);
  const label = 'GET /v1/approvals/inbox';
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const items = z.array(InboxItemDtoSchema).safeParse(body);
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
  if (!items.success || total === undefined) {
    throw new ApiError(502, `${label} returned an invalid body`, items.error?.issues);
  }
  return { items: items.data, total };
}

/**
 * `GET /v1/approvals/inbox/count`: how many inbox items wait on the caller, from the same eligibility checks as the list (the API
 * skips only building the items). A caller with no approval assignment gets 403 `out_of_scope`, which is normal for
 * non-approvers; it throws like any other refusal, so the caller leaves the badge out instead of showing 0.
 */
export function getInboxCount(session: Session): Promise<{ count: number }> {
  return call(session, '/v1/approvals/inbox/count', InboxCountDtoSchema);
}

export function getApprovalRequest(session: Session, id: string): Promise<ApprovalRequestDto> {
  return call(session, `/v1/approvals/requests/${seg(id)}`, ApprovalRequestDtoSchema);
}

/**
 * `POST /v1/approvals/requests/:id/actions`. The API refuses a call without `Idempotency-Key`
 * (400), so the key is a required argument here: a missing key is a compile error, not a runtime one.
 *
 * K7: `idToken` is the session's OIDC ID token, the only token that carries `auth_time`. It goes
 * in `x-bos-id-token` so the API can check a step that needs a recent sign-in. This is the only
 * call that sends it. Without one the header is left out and the API answers `step_up_required`
 * for such a step. The token is never put in an error: `call` builds messages from the method,
 * path and status only.
 */
export function actOnApproval(
  session: Session,
  id: string,
  body: ApprovalActionBody,
  idempotencyKey: string,
  idToken?: string,
): Promise<ApprovalRequestDto> {
  return call(
    session,
    `/v1/approvals/requests/${seg(id)}/actions`,
    ApprovalRequestDtoSchema,
    json('POST', body, {
      'idempotency-key': idempotencyKey,
      ...(idToken ? { 'x-bos-id-token': idToken } : {}),
    }),
  );
}

/** `POST /v1/approvals/preview`: the route a document would take, with each step's reason. */
export function previewRoute(
  session: Session,
  input: { documentType: string; facts: Record<string, unknown>; sodUserIds?: string[] },
): Promise<RoutePlan> {
  return call(session, '/v1/approvals/preview', RoutePlanSchema, json('POST', input));
}

// ---------------------------------------------------------------------------------------------
// Test memos
// ---------------------------------------------------------------------------------------------

export function createMemo(session: Session, body: CreateMemoBody): Promise<Memo> {
  return call(session, '/v1/test-memos', MemoDtoSchema, json('POST', body));
}

/**
 * `GET /v1/test-memos`: one page of the memos the caller may open, newest first. Scope is decided by the API from
 * the caller's grants; filters only narrow it. Pass `nextCursor` back as `cursor` for the next page. `status` may
 * be several values (sent repeated); `q` is the search text; `total` is every match, not just this page.
 */
export function listMemos(
  session: Session,
  opts: { limit?: number; cursor?: string; status?: string | readonly string[]; q?: string } = {},
): Promise<MemoList> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
  for (const status of typeof opts.status === 'string' ? [opts.status] : (opts.status ?? [])) {
    query.append('status', status);
  }
  if (opts.q !== undefined) query.set('q', opts.q);
  const qs = query.toString();
  return call(session, `/v1/test-memos${qs === '' ? '' : `?${qs}`}`, MemoListSchema);
}

export function getMemo(session: Session, id: string): Promise<MemoDetail> {
  return call(session, `/v1/test-memos/${seg(id)}`, MemoDetailSchema);
}

export function updateMemo(
  session: Session,
  id: string,
  body: Partial<CreateMemoBody> & { expectedVersion?: number },
): Promise<Memo> {
  return call(session, `/v1/test-memos/${seg(id)}`, MemoDtoSchema, json('PATCH', body));
}

/**
 * `GET /v1/test-memos/:id/route`: the approval route submit would build for this memo now. For an internal
 * memo it is the people the author selected, in order; for a historical memo with an amount it is the
 * workflow's role steps. The page shows it before the author submits.
 */
export function getMemoRoute(session: Session, id: string): Promise<RoutePlan> {
  return call(session, `/v1/test-memos/${seg(id)}/route`, RoutePlanSchema);
}

export function submitMemo(
  session: Session,
  id: string,
  expectedVersion?: number,
): Promise<SubmitMemoResult> {
  return call(
    session,
    `/v1/test-memos/${seg(id)}/submit`,
    SubmitMemoResultSchema,
    json('POST', { expectedVersion }),
  );
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** Step 1 of an upload: reserve the document and its first version. */
export function createDocument(
  session: Session,
  body: CreateDocumentBody,
): Promise<CreatedDocument> {
  return call(session, '/v1/documents', CreatedDocumentSchema, json('POST', body));
}

/** The content route the API hands back must be the one for this document and version. */
function contentPath(created: Pick<CreatedDocument, 'documentId' | 'versionId' | 'uploadPath'>) {
  const expected = `/v1/documents/${created.documentId}/versions/${created.versionId}/content`;
  // Trust the API's own path when it matches; otherwise refuse rather than send a file elsewhere.
  if (created.uploadPath !== expected) {
    throw new ApiError(502, 'POST /v1/documents returned an unexpected uploadPath');
  }
  return created.uploadPath;
}

interface ContentUpload {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType: string;
}

/**
 * Step 2 of an upload: stream the bytes. The API reads the raw request body and requires
 * `Content-Length` (411 without it), so the browser's length is forwarded and the body is never
 * buffered here. `duplex: 'half'` is what Node's fetch demands for a streamed request body.
 */
export async function uploadDocumentContent(
  session: Session,
  created: Pick<CreatedDocument, 'documentId' | 'versionId' | 'uploadPath'>,
  upload: ContentUpload,
): Promise<z.infer<typeof DocumentVersionDtoSchema>> {
  return await streamContent(session, contentPath(created), upload);
}

async function streamContent(
  session: Session,
  path: string,
  upload: ContentUpload,
): Promise<z.infer<typeof DocumentVersionDtoSchema>> {
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
  return await call(session, path, DocumentVersionDtoSchema, init);
}

/** The API path of a record's evidence uploads (round 5 P2), by the record kind the workspace names. */
const EVIDENCE_BASE: Record<EvidenceKind, string> = {
  'sales-order': '/v1/sales-orders',
  'vendor-bill': '/v1/payables/bills',
  rfq: '/v1/procurement/rfqs',
};

function evidencePath(kind: EvidenceKind, ownerId: string): string {
  return `${EVIDENCE_BASE[kind]}/${seg(ownerId)}/evidence-documents`;
}

/**
 * Step 1 of an evidence upload: reserve a document owned by `evidence` + the record, through the
 * record's own route (it checks that record's permission, not `documents.upload`).
 */
export function createEvidenceDocument(
  session: Session,
  kind: EvidenceKind,
  ownerId: string,
  body: Pick<CreateDocumentBody, 'filename' | 'declaredMime' | 'sizeBytes'>,
): Promise<CreatedDocument> {
  return call(session, evidencePath(kind, ownerId), CreatedDocumentSchema, json('POST', body));
}

/**
 * Reads an evidence document and its versions through the record's own route
 * (`GET <record>/:id/evidence-documents/:documentId`, that record's permission, not
 * `documents.read`).
 */
export function getEvidenceDocument(
  session: Session,
  kind: EvidenceKind,
  ownerId: string,
  documentId: string,
): Promise<DocumentDetail> {
  return call(session, `${evidencePath(kind, ownerId)}/${seg(documentId)}`, DocumentSchema);
}

/** Step 2 of an evidence upload: stream the bytes to the content route of the reserved version. */
export async function uploadEvidenceContent(
  session: Session,
  kind: EvidenceKind,
  ownerId: string,
  created: Pick<CreatedDocument, 'documentId' | 'versionId' | 'uploadPath'>,
  upload: ContentUpload,
): Promise<z.infer<typeof DocumentVersionDtoSchema>> {
  const expected = `${evidencePath(kind, ownerId)}/${created.documentId}/versions/${created.versionId}/content`;
  // Trust the API's own path when it matches; otherwise refuse rather than send a file elsewhere.
  if (created.uploadPath !== expected) {
    throw new ApiError(502, 'The evidence upload returned an unexpected uploadPath');
  }
  return await streamContent(session, expected, upload);
}

/**
 * Removes an evidence file its uploader abandoned before saving, through the record's own route
 * (`DELETE <record>/:id/evidence-documents/:documentId`, that record's permission, not
 * `documents.upload`). 204 also when it is already removed; 403 for anyone but the uploader; 409
 * once the record took the file or stopped taking evidence.
 */
export async function removeEvidenceDocument(
  session: Session,
  kind: EvidenceKind,
  ownerId: string,
  documentId: string,
): Promise<void> {
  const path = `${evidencePath(kind, ownerId)}/${seg(documentId)}`;
  const res = await apiFetch(session, path, { method: 'DELETE' });
  if (!res.ok) {
    throw new ApiError(res.status, `DELETE ${path} failed with ${res.status}`, await readBody(res));
  }
}

/** `POST /v1/documents/:id/versions/:versionId/link`: a 60-second, single-use signed link. */
export function issueDocumentLink(
  session: Session,
  documentId: string,
  versionId: string,
): Promise<SignedLinkDto> {
  return call(
    session,
    `/v1/documents/${seg(documentId)}/versions/${seg(versionId)}/link`,
    SignedLinkDtoSchema,
    json('POST', {}),
  );
}

/** `DELETE /v1/documents/:id` answers 204 with no body (soft removal on an editable owner). */
export async function removeDocument(session: Session, documentId: string): Promise<void> {
  const res = await apiFetch(session, `/v1/documents/${seg(documentId)}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `DELETE /v1/documents/${seg(documentId)} failed with ${res.status}`,
      await readBody(res),
    );
  }
}

const SIGNED_PATH = /^\/v1\/files\/[A-Za-z0-9._~-]+$/;

/**
 * Fetches the bytes behind a signed link. The link is a relative `/v1/files/<token>` path on the
 * API origin and the workspace has no public API URL (its CSP is `connect-src 'self'`), so the BFF
 * fetches it over the internal URL and streams it on. The caller streams `res.body` to the browser.
 */
export async function openSignedFile(session: Session, link: SignedLinkDto): Promise<Response> {
  if (!SIGNED_PATH.test(link.url)) {
    throw new ApiError(502, 'The API returned a download link in an unexpected form');
  }
  const res = await apiFetch(session, link.url, { method: 'GET' });
  if (!res.ok) {
    throw new ApiError(res.status, `GET /v1/files failed with ${res.status}`, await readBody(res));
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export function listNotifications(
  session: Session,
  opts: { limit?: number; before?: string } = {},
): Promise<NotificationDto[]> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  if (opts.before !== undefined) query.set('before', opts.before);
  const qs = query.size > 0 ? `?${query.toString()}` : '';
  return call(session, `/v1/notifications${qs}`, z.array(NotificationDtoSchema));
}

export function getUnreadCount(session: Session): Promise<UnreadCountDto> {
  return call(session, '/v1/notifications/unread-count', UnreadCountDtoSchema);
}

/** `POST /v1/notifications/:id/read` answers 204 with no body, so nothing is parsed. */
export async function markNotificationRead(session: Session, id: string): Promise<void> {
  const res = await apiFetch(session, `/v1/notifications/${seg(id)}/read`, { method: 'POST' });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST notification read failed with ${res.status}`,
      await readBody(res),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

/** `GET /v1/audit?entityId=`: the API wraps the list as `{ items }`. Needs `audit.read`. */
export async function listAudit(
  session: Session,
  opts: { entityId: string; limit?: number },
): Promise<AuditEventDto[]> {
  const query = new URLSearchParams({ entityId: opts.entityId });
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  const { items } = await call(session, `/v1/audit?${query.toString()}`, AuditListSchema);
  return items;
}

export const getMemoDirectory = (session: Session) =>
  call(session, '/v1/test-memos/directory', MemoDirectorySchema);
