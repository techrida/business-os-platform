import 'server-only';

import {
  type VendorBankChangeRequestBody,
  VendorBankChangeRequestBodySchema,
  VendorBankAccountDtoSchema,
  type VendorBillSubmissionBody,
  VendorBillSubmissionBodySchema,
  type VendorKycDocumentSubmissionBody,
  VendorKycDocumentSubmissionBodySchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Server-to-server writes for the vendor portal (P4 PTV-U), over `/v1/portal/vendor`. A file is
 * three steps: the declaration (`POST <kind>/files`), a raw `PUT` of the bytes to the path the API
 * answers with, then the submission that names the document and carries an Idempotency-Key.
 *
 * Paths used (the controller on the P4 integration branch is the source):
 *
 *   POST /v1/portal/vendor/kyc-documents/files            -> { documentId, versionId, uploadPath }
 *   POST /v1/portal/vendor/bill-submissions/files         -> { documentId, versionId, uploadPath }
 *   PUT  <uploadPath>  (raw bytes, own Content-Type)      -> 2xx
 *   POST /v1/portal/vendor/kyc-documents                  (Idempotency-Key) -> 2xx
 *   POST /v1/portal/vendor/bill-submissions               (Idempotency-Key) -> 2xx
 *   POST /v1/portal/vendor/bank-change-requests           (Idempotency-Key) -> bank account, last four only
 *
 * The vendor's party comes from the token on the API side; nothing here sends a party or vendor id.
 * Every body is parsed with its strict contract first, so a field outside it cannot be sent.
 */

/** The two uploads that carry a file. A bank change request has no document. */
export const UPLOAD_KINDS = ['kyc-documents', 'bill-submissions'] as const;
export type VendorUploadKind = (typeof UPLOAD_KINDS)[number];

const UploadStartSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: z.string(),
});

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The only upload path the portal will send the bearer token to: this kind's, for exactly the
 * document and version the declaration returned. Built here, so the answer is compared with a
 * string the portal made, not matched against a pattern a crafted path could slip past. The ids
 * are GUIDs (hex and hyphens), so nothing in it can climb out of the route or change the origin.
 */
function expectedUploadPath(kind: VendorUploadKind, documentId: string, versionId: string): string {
  return `/v1/portal/vendor/${kind}/files/${documentId}/versions/${versionId}/content`;
}

/**
 * Declares a file and streams its bytes to the API. Returns the document id for the submission;
 * the version id and the upload path stay on the server. A refusal at either step throws
 * `ApiError` with the API's status; a path outside the exact form throws 502 before the PUT.
 */
export async function uploadVendorFile(
  session: Session,
  kind: VendorUploadKind,
  file: { filename: string; mime: string; size: number; body: ReadableStream<Uint8Array> },
): Promise<{ documentId: string }> {
  const declare = `/v1/portal/vendor/${kind}/files`;
  const res = await apiFetch(session, declare, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.filename,
      declaredMime: file.mime,
      sizeBytes: file.size,
    }),
  });
  const answer = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `POST ${declare} failed with ${res.status}`, answer);
  const started = UploadStartSchema.safeParse(answer);
  if (
    !started.success ||
    started.data.uploadPath !==
      expectedUploadPath(kind, started.data.documentId, started.data.versionId)
  ) {
    throw new ApiError(502, 'The API returned an upload path in an unexpected form');
  }
  const put = await apiFetch(session, started.data.uploadPath, {
    method: 'PUT',
    headers: { 'content-type': file.mime, 'content-length': String(file.size) },
    body: file.body,
    // Node's fetch needs this to stream a request body.
    duplex: 'half',
  } as RequestInit);
  if (!put.ok) {
    throw new ApiError(
      put.status,
      `PUT file content failed with ${put.status}`,
      await readBody(put),
    );
  }
  return { documentId: started.data.documentId };
}

/**
 * Sends one JSON submission. The key is required, so a missing one is a compile error: a retry
 * after a timeout must reuse it so the submission cannot be recorded twice. Any 2xx is success.
 */
async function submit(
  session: Session,
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<Response> {
  const res = await apiFetch(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `POST ${path} failed with ${res.status}`, await readBody(res));
  }
  return res;
}

/** `POST /v1/portal/vendor/kyc-documents`: puts an uploaded file on a checklist item for staff to review. */
export async function submitVendorKycDocument(
  session: Session,
  body: VendorKycDocumentSubmissionBody,
  idempotencyKey: string,
): Promise<void> {
  const checked = VendorKycDocumentSubmissionBodySchema.parse(body);
  await submit(session, '/v1/portal/vendor/kyc-documents', checked, idempotencyKey);
}

/**
 * `POST /v1/portal/vendor/bill-submissions`: the vendor's claim, as an inbox row. Staff key the
 * real bill, so the total here is the vendor's own figure as typed (text, never arithmetic).
 */
export async function submitVendorBill(
  session: Session,
  body: VendorBillSubmissionBody,
  idempotencyKey: string,
): Promise<void> {
  const checked = VendorBillSubmissionBodySchema.parse(body);
  await submit(session, '/v1/portal/vendor/bill-submissions', checked, idempotencyKey);
}

/** The bank change request has no document: the API answers 422 to one, so the type leaves it out. */
const BankChangeBodySchema = VendorBankChangeRequestBodySchema.omit({ supportingDocumentId: true });
export type VendorBankChange = Omit<VendorBankChangeRequestBody, 'supportingDocumentId'>;

/** What the page may say about a proposed account: bank, last four digits and state. Never the number. */
export interface BankChangeReceipt {
  bankName: string;
  last4: string;
  status: string;
}

/**
 * `POST /v1/portal/vendor/bank-change-requests`: proposes an account for staff to verify. The
 * answer is the account as the API stores it (last four digits only); only the bank name, the
 * last four and the status are read from it, so no other field can reach a page. A 2xx whose body
 * cannot be read is `null`: the request landed, and failing it would only invite a second one.
 * The number is not echoed anywhere: not in the receipt, and not in an error, which carries only
 * the API's machine code.
 */
export async function requestVendorBankChange(
  session: Session,
  body: VendorBankChange,
  idempotencyKey: string,
): Promise<BankChangeReceipt | null> {
  const checked = BankChangeBodySchema.parse(body);
  const path = '/v1/portal/vendor/bank-change-requests';
  const res = await apiFetch(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(checked),
  });
  const answer = await readBody(res);
  if (!res.ok) {
    const code = (answer as { error?: { code?: unknown } } | null | undefined)?.error?.code;
    throw new ApiError(
      res.status,
      `POST ${path} failed with ${res.status}`,
      typeof code === 'string' ? { error: { code } } : undefined,
    );
  }
  const parsed = VendorBankAccountDtoSchema.safeParse(answer);
  if (!parsed.success) return null;
  return {
    bankName: parsed.data.bankName,
    last4: parsed.data.accountLast4,
    status: parsed.data.status,
  };
}
