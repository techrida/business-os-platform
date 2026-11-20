/**
 * The "session store could not answer" outcome, shared by the server (which throws it) and the
 * error boundaries (which recognise it). No `server-only`: error boundaries are Client Components.
 *
 * Next.js keeps a thrown error's own `digest` when it forwards a Server Component error to the
 * browser (production strips the message, not the digest), so the digest is how a boundary tells
 * this outcome from any other failure.
 */
export const SESSION_UNAVAILABLE_DIGEST = 'BOS_SESSION_UNAVAILABLE';

/** Shown on pages and returned by Route Handlers (with 503). */
export const SESSION_UNAVAILABLE_MESSAGE = 'Session check temporarily unavailable. Retry.';

/**
 * Thrown when the session store did not answer within its deadline. Never means "signed out": the
 * cookie stays, and no protected content is served for this request.
 */
export class SessionUnavailableError extends Error {
  override name = 'SessionUnavailableError';
  readonly digest = SESSION_UNAVAILABLE_DIGEST;
  constructor() {
    super('Session check temporarily unavailable');
  }
}

/** True for a SessionUnavailableError, including the digest-only copy a boundary receives. */
export function isSessionUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { digest?: unknown }).digest === SESSION_UNAVAILABLE_DIGEST
  );
}
