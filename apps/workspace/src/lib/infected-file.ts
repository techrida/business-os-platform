// TR-Q12e: the API refuses a file the virus scan found infected wherever a record takes it, with one 409 code,
// `document_infected`, whose message names the file. Every screen that saves a record with a file shows that
// message in the app rather than its generic "this changed, reload" conflict words. Pure (no server-only import),
// so client components and their tests can use it too.
import { ErrorBodySchema } from '@bos/contracts';

/** Shown when the refusal carries no message of its own. */
export const INFECTED_FILE =
  'A virus was found in this file. Remove it or upload a clean copy, then try again.';

/** The words for a `document_infected` refusal (an ApiError-like `{status, body}`), or undefined for anything else. */
export function infectedFileMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, body } = err as { status?: unknown; body?: unknown };
  if (status !== 409) return undefined;
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success || parsed.data.error.code !== 'document_infected') return undefined;
  const message = parsed.data.error.message.trim();
  return message === '' ? INFECTED_FILE : message;
}
