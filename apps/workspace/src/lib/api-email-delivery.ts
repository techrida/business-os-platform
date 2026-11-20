import 'server-only';

// Server-only calls to the email delivery log routes (Settings > Email delivery). Same rules as api-admin.ts: the
// user's session goes with every call and every answer is parsed with Zod, so a drifting API shape fails here
// (502) instead of rendering garbage.
import {
  type EmailDeliveryFilter,
  type EmailDeliveryPage,
  EmailDeliveryPageSchema,
  type EmailResendResult,
  EmailResendResultSchema,
} from '@bos/contracts';
import type { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

async function call<S extends z.ZodType>(
  session: Session,
  method: 'GET' | 'POST',
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const res = await apiFetch(session, path, { method });
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${method} ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

export function listEmailDeliveries(
  session: Session,
  q: { filter: EmailDeliveryFilter; before?: string | undefined },
): Promise<EmailDeliveryPage> {
  const params = new URLSearchParams({ filter: q.filter, limit: '50' });
  if (q.before !== undefined) params.set('before', q.before);
  return call(
    session,
    'GET',
    `/v1/admin/email-deliveries?${params.toString()}`,
    EmailDeliveryPageSchema,
  );
}

export function resendEmail(session: Session, id: string): Promise<EmailResendResult> {
  return call(
    session,
    'POST',
    `/v1/admin/email-deliveries/${encodeURIComponent(id)}/resend`,
    EmailResendResultSchema,
  );
}
