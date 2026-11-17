import 'server-only';

import {
  VerificationCaseDtoSchema,
  VerificationReviewHistorySchema,
  type ReviewVerificationItemBody,
  type AttachVerificationDocumentBody,
  type VerificationCaseDto,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { DocumentSchema, type DocumentDetail } from './verification-file';

/**
 * Typed calls from the workspace BFF to the write routes of the KYB cases
 * (apps/api/src/modules/verification/verification.controller.ts). Reads and the reviewer's
 * decision are in `../customers/api.ts`. Every response is parsed with the contracts' schema, so an
 * API that drifts fails here (502) instead of rendering `undefined`.
 *
 */

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

function json(method: string, body: unknown, key: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  };
}

/**
 * `POST /v1/verification-cases` (needs `customer.write`). One case per customer: 201 with a new
 * draft, 200 with the existing case, or with an expired case reopened as a draft. Both parse the same.
 */
export function openVerificationCase(
  session: Session,
  partyId: string,
  idempotencyKey: string,
): Promise<VerificationCaseDto> {
  return call(
    session,
    '/v1/verification-cases',
    VerificationCaseDtoSchema,
    json('POST', { partyId }, idempotencyKey),
  );
}

/**
 * `PATCH /v1/verification-cases/:id/checklist` (needs `customer.write`): puts one uploaded document
 * on one checklist item, one item per call. The document must have been uploaded with owner type
 * `verification_case` and this case id (422 otherwise). 409 unless the case is a draft or
 * rejected, or when `expectedVersion` is stale; attaching on a rejected case sends it back to a
 * draft. Answers 200 with the case.
 */
export function attachChecklistDocument(
  session: Session,
  caseId: string,
  body: AttachVerificationDocumentBody,
  idempotencyKey: string,
): Promise<VerificationCaseDto> {
  return call(
    session,
    `/v1/verification-cases/${encodeURIComponent(caseId)}/checklist`,
    VerificationCaseDtoSchema,
    json('PATCH', body, idempotencyKey),
  );
}

/**
 * `POST /v1/verification-cases/:id/submit` (needs `customer.write`): draft to submitted. 409 unless
 * the case is a draft, or while a required item has no document. Answers 200 with the case.
 */
export function submitVerificationCase(
  session: Session,
  caseId: string,
  idempotencyKey: string,
  expectedVersion: number,
): Promise<VerificationCaseDto> {
  return call(
    session,
    `/v1/verification-cases/${encodeURIComponent(caseId)}/submit`,
    VerificationCaseDtoSchema,
    json('POST', { expectedVersion }, idempotencyKey),
  );
}

/**
 * `GET /v1/documents/:id` (needs `documents.read`, scoped like the owning record): the document with
 * its versions and their scan status. The case page uses it to find which version to open.
 */
export function getDocument(session: Session, documentId: string): Promise<DocumentDetail> {
  return call(session, `/v1/documents/${encodeURIComponent(documentId)}`, DocumentSchema);
}

export function reviewVerificationItem(
  session: Session,
  id: string,
  key: string,
  body: ReviewVerificationItemBody,
  retryKey: string,
) {
  return call(
    session,
    `/v1/verification-cases/${encodeURIComponent(id)}/checklist/${encodeURIComponent(key)}/decision`,
    VerificationCaseDtoSchema,
    json('POST', body, retryKey),
  );
}
export function detachVerificationItem(
  session: Session,
  id: string,
  key: string,
  expectedVersion: number,
  retryKey: string,
) {
  return call(
    session,
    `/v1/verification-cases/${encodeURIComponent(id)}/checklist/${encodeURIComponent(key)}`,
    VerificationCaseDtoSchema,
    json('DELETE', { expectedVersion }, retryKey),
  );
}
export function getVerificationReviewHistory(session: Session, id: string, before?: string) {
  return call(
    session,
    `/v1/verification-cases/${encodeURIComponent(id)}/review-history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    VerificationReviewHistorySchema,
  );
}
