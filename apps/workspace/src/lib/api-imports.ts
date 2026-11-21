import 'server-only';

import {
  type PartyImportBatch,
  PartyImportBatchSchema,
  type PartyImportDetail,
  PartyImportDetailSchema,
  type PartyImportKind,
  ErrorBodySchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import { failureOf } from './api-kernel';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the customer and vendor CSV import routes (`/v1/imports`). Server-only: every
 * call carries the user's access token. The upload goes to the API as the raw `text/csv` body (the API parses and
 * checks it; nothing is stored but the batch record), and each response is parsed with the contract's schema.
 */

async function parse<T>(res: Response, what: string, schema: z.ZodType<T>): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, `${what} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(502, `${what} returned an invalid body`, parsed.error.issues);
  return parsed.data;
}

/** Uploads the file's bytes for checking. Answers the previewed batch (201). */
export async function previewImport(
  session: Session,
  kind: PartyImportKind,
  fileName: string,
  bytes: ArrayBuffer,
): Promise<PartyImportDetail> {
  const path = `/v1/imports/${kind === 'customer' ? 'customers' : 'vendors'}?${new URLSearchParams({ filename: fileName.slice(0, 200) })}`;
  const res = await apiFetch(session, path, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: bytes,
  });
  return parse(res, 'POST /v1/imports', PartyImportDetailSchema);
}

/** Creates the valid rows of a previewed batch. Committing a committed batch answers it again unchanged. */
export async function commitImport(session: Session, id: string): Promise<PartyImportDetail> {
  const res = await apiFetch(session, `/v1/imports/${encodeURIComponent(id)}/commit`, {
    method: 'POST',
  });
  return parse(res, 'POST /v1/imports/:id/commit', PartyImportDetailSchema);
}

export async function getImport(session: Session, id: string): Promise<PartyImportDetail> {
  const res = await apiFetch(session, `/v1/imports/${encodeURIComponent(id)}`, { method: 'GET' });
  return parse(res, 'GET /v1/imports/:id', PartyImportDetailSchema);
}

export async function listImports(
  session: Session,
  kind: PartyImportKind,
): Promise<PartyImportBatch[]> {
  const res = await apiFetch(session, `/v1/imports?${new URLSearchParams({ kind })}`, {
    method: 'GET',
  });
  return parse(res, 'GET /v1/imports', z.array(PartyImportBatchSchema));
}

/**
 * What to tell the person when an import call failed. The import API's own refusals of a file (400 not a CSV or not the
 * template, 413 over 2 MB, 415 not text/csv) carry a message written for this screen and naming columns, never cell
 * values, so it is shown as it is; every other failure uses the shared wording.
 */
export function importFailureMessage(err: unknown): string {
  if (err instanceof ApiError && (err.status === 400 || err.status === 413 || err.status === 415)) {
    const parsed = ErrorBodySchema.safeParse(err.body);
    if (parsed.success && parsed.data.error.message !== '') return parsed.data.error.message;
  }
  return failureOf(err).message;
}
