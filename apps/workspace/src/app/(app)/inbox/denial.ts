import { ErrorBodySchema } from '@bos/contracts';

import { ApiError } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';

/** Said when the API refused the inbox without saying why. Claims no cause it does not know. */
export const INBOX_DENIED = "You can't open the inbox.";

/**
 * Why the inbox was refused (403), in words. The API's own message comes first: its 403 messages are fixed
 * sentences from its authorization checks (for example "You have no approval assignment"), never data. The bare
 * "Forbidden" of a generic denial says nothing, so then a known `reason` is described, else the neutral line.
 * A refusal can come from several checks (the role, the legal entity, the account), so this never assumes one.
 */
export function inboxDenialMessage(err: unknown): string {
  if (!(err instanceof ApiError) || err.status !== 403) return INBOX_DENIED;
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (!parsed.success) return INBOX_DENIED;
  const { message, reason } = parsed.data.error;
  const text = message.trim();
  if (text !== '' && text !== 'Forbidden') return /[.!?]$/.test(text) ? text : `${text}.`;
  return reason !== undefined ? failureOf(err).message : INBOX_DENIED;
}
