// Turns an API failure into one sentence an admin can act on. Serves the NFR "errors name the problem
// and the recovery": a 403 says what the user may not do, never a status code or a stack.
//
// It duck-types `status` and `body` (what ApiError carries) so it stays a plain module: no
// `server-only`, usable from tests and from Server Actions alike.
import { ErrorBodySchema } from '@bos/contracts';

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = error.status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

/** The API's own message from its error envelope, when it sent one (400 and 409 explain themselves). */
function apiMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('body' in error)) return null;
  const parsed = ErrorBodySchema.safeParse(error.body);
  const message = parsed.success ? parsed.data.error.message.trim() : '';
  return message === '' ? null : message;
}

/**
 * `action` is a verb phrase that fits "You don't have permission to ...", for example
 * "invite users" or "view FX rates".
 */
export function describeError(error: unknown, action: string): string {
  const status = statusOf(error);
  switch (status) {
    case 401:
      return 'Your session has expired. Sign in again to continue.';
    case 403:
      return `You don't have permission to ${action}.`;
    case 400:
    case 404:
    case 409:
    case 422:
      return (
        apiMessage(error) ?? `That could not be done: ${action}. Check the details and try again.`
      );
    case 503:
      return apiMessage(error) ?? 'This feature is not available right now.';
    default:
      return 'The platform API did not answer as expected. Try again in a moment.';
  }
}

export function isForbidden(error: unknown): boolean {
  return statusOf(error) === 403;
}
