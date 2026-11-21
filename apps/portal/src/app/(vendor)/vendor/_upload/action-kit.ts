import { randomUUID } from 'node:crypto';

import { plainAmount } from '@bos/locale';
import { redirect } from 'next/navigation';

import { ApiError } from '@/lib/api';
import { getSession, type Session } from '@/lib/session';

/**
 * What the three vendor write forms share: the form state, reading a field, the signed-in vendor,
 * and the words for a refused or failed call. Server only (the actions import it; no Client
 * Component does). Error text is ours, never the API's: its detail could name internal ids or rules.
 */

export interface FormState<Field extends string> {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  fieldErrors?: Partial<Record<Field, string>>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
export const KEY = /^[A-Za-z0-9-]{8,64}$/;

export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** Vendors type lakh grouping ("20,18,180.00"); the contract wants plain digits. A string clean-up, not arithmetic. */
export function normalizeAmount(raw: string): string {
  return plainAmount(raw);
}

/** The key from the form when it is well-formed, else the one the form state carries. */
export function keyOf(form: FormData, prev: { key: string }): string {
  const submitted = text(form, 'idempotencyKey');
  return KEY.test(submitted) ? submitted : prev.key;
}

export const loginUrl = (returnTo: string): string =>
  `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

/**
 * The signed-in vendor, or null for any other kind of session. Server actions run no layout, so
 * the layout's vendor check does not cover them: each action asks here before anything is sent.
 * No session at all goes to sign-in and back.
 */
export async function vendorSession(returnTo: string): Promise<Session | null> {
  const session = await getSession();
  if (!session) redirect(loginUrl(returnTo));
  return session.orgKind === 'vendor' ? session : null;
}

/** The API's machine code (`error.code`), or '' when the body has none. Only the code is read, never its message. */
export function codeOf(err: unknown): string {
  if (!(err instanceof ApiError)) return '';
  const e = (err.body as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof e?.code === 'string' ? e.code : '';
}

export const NOT_A_VENDOR = 'Sign in with your vendor account to do this.';

/** The API's words for a `document_infected` refusal, or a fixed sentence without them. */
function infectedMessage(err: unknown): string {
  const e = (err instanceof ApiError ? err.body : undefined) as
    { error?: { message?: unknown } } | null | undefined;
  const message = e?.error?.message;
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : 'A virus was found in this file. Upload a clean copy, then submit again.';
}

/**
 * Words for a refused or failed call. A definite refusal rotates the key; an unknown outcome (a
 * timeout, a 5xx) and the in-progress 409 keep it, so the retry replays the first request instead
 * of creating a second one. A 401 goes to sign-in; a 403 is the account, not the form.
 */
export function failed<Field extends string>(
  err: unknown,
  key: string,
  returnTo: string,
  what: { noun: string; forbidden: string },
): FormState<Field> {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 401) redirect(loginUrl(returnTo));
  if (status === 403) return { key: randomUUID(), error: what.forbidden };
  if (status === 409 && codeOf(err) === 'document_infected') {
    // TR-Q12e: the scan found a virus in the attached file; the API's message names it.
    return { key: randomUUID(), error: infectedMessage(err) };
  }
  if (status === 409) {
    return {
      key,
      error: `Your ${what.noun} is still being recorded. Wait a moment and press Submit again; it will only be recorded once.`,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      key: randomUUID(),
      error:
        codeOf(err) === 'validation_failed'
          ? `We could not record your ${what.noun}. Check the details and try again.`
          : `We could not record your ${what.noun}. Reload the page and try again, or contact us.`,
    };
  }
  return {
    key,
    error: `We could not confirm your ${what.noun} just now. Please try again; it will only be recorded once.`,
  };
}
