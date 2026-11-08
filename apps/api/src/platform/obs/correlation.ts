import { randomUUID } from 'node:crypto';

/** Same pattern as `CorrelationIdSchema` in @bos/contracts. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Returns the caller's id when it is safe to reuse, otherwise a fresh UUID.
 *
 * The id lands in logs and in a response header, so an unchecked value would let a caller forge
 * log lines (newlines) or inject headers. Shared by the tenancy middleware and pino's genReqId
 * so both apply the same rule; this file imports nothing from either to avoid a cycle.
 */
export function newCorrelationId(incoming?: string | null): string {
  if (typeof incoming === 'string' && VALID_CORRELATION_ID.test(incoming)) return incoming;
  return randomUUID();
}
