import 'server-only';

import { CurrencySchema, PAYMENT_STATUSES } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * The reused bank reference check for the record payment form (TR-Q12d). Server-only: the call
 * carries the user's access token. The answer is parsed, so an API that drifts fails with a 502.
 */

const PaymentReferenceMatchesSchema = z.strictObject({
  matches: z.array(
    z.strictObject({
      id: z.guid(),
      number: z.string().nullable(),
      customerName: z.string().nullable(),
      receivedOn: z.iso.date(),
      amount: z.string().regex(/^\d+\.\d{2}$/),
      currency: CurrencySchema,
      status: z.enum(PAYMENT_STATUSES),
    }),
  ),
});
export type PaymentReferenceMatch = z.infer<
  typeof PaymentReferenceMatchesSchema
>['matches'][number];

/**
 * `GET /v1/payments/reference-matches?bankReference=`: the payments of the acting entity the user
 * may read whose bank reference matches once case and spaces are set aside, newest first. A warning
 * for the record form; the API never refuses a payment for its reference.
 */
export async function findPaymentReferenceMatches(
  session: Session,
  bankReference: string,
): Promise<PaymentReferenceMatch[]> {
  const path = `/v1/payments/reference-matches?${new URLSearchParams({ bankReference }).toString()}`;
  const res = await apiFetch(session, path);
  const text = await res.text();
  let body: unknown = undefined;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  const label = 'GET /v1/payments/reference-matches';
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = PaymentReferenceMatchesSchema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the route promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data.matches;
}
