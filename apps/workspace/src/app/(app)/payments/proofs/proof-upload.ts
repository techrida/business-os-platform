import 'server-only';

import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/**
 * Stores one proof file in the API's two steps, the way the documents kernel does it: announce the
 * file and the customer it is for, then send the bytes with their own content type. The bytes are a
 * stream and are never read here. The upload path the API returns is checked against a strict
 * pattern before the bearer token is sent to it. Returns the document id that goes into
 * `proofDocumentIds`. Serves the NFR "no unscanned file is ever used": the API still scans the file
 * and refuses a payment whose proof is not clean yet (422 `invalid_proof`).
 */

const UploadStartSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: z.string(),
});

const UPLOAD_PATH = /^\/v1\/payment-proofs\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/content$/i;

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function uploadStaffPaymentProof(
  session: Session,
  file: {
    customerId: string;
    filename: string;
    mime: string;
    size: number;
    body: ReadableStream<Uint8Array>;
  },
): Promise<string> {
  const startRes = await apiFetch(session, '/v1/payment-proofs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customerId: file.customerId,
      filename: file.filename,
      declaredMime: file.mime,
      sizeBytes: file.size,
    }),
  });
  const startBody = await readBody(startRes);
  if (!startRes.ok) {
    throw new ApiError(
      startRes.status,
      `POST /v1/payment-proofs failed with ${startRes.status}`,
      startBody,
    );
  }
  const started = UploadStartSchema.safeParse(startBody);
  if (!started.success) {
    throw new ApiError(502, 'POST /v1/payment-proofs returned an invalid body');
  }
  if (!UPLOAD_PATH.test(started.data.uploadPath)) {
    throw new ApiError(502, 'The API returned an upload path in an unexpected form');
  }
  const res = await apiFetch(session, started.data.uploadPath, {
    method: 'PUT',
    headers: { 'content-type': file.mime, 'content-length': String(file.size) },
    body: file.body,
    // Node's fetch needs this to stream a request body.
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PUT proof content failed with ${res.status}`,
      await readBody(res),
    );
  }
  return started.data.documentId;
}
