import 'server-only';

import { type LostReasonReport, LostReasonReportSchema } from '@bos/contracts';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

const PATH = '/v1/opportunities/reports/lost-reasons';

/** `GET /v1/opportunities/reports/lost-reasons`: lost deals by reason and month, the last 12 months by default. */
export async function getLostReasonReport(session: Session): Promise<LostReasonReport> {
  const res = await apiFetch(session, PATH);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, `GET ${PATH} failed with ${res.status}`, body);
  const parsed = LostReasonReportSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${PATH} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}
