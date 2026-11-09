import 'server-only';

import { redirect } from 'next/navigation';

import { ApiError } from '@/lib/api';

/**
 * What a vendor page does with an API refusal, in one place so every page answers the same way:
 * 403 is "this account cannot use the page" (rendered in place with a sign-out button, so the
 * vendor stays on the page they asked for), 404 is the one not-found answer, 401 signs in again
 * and returns to the same page. Anything else is thrown for error.tsx.
 */
export type Loaded<T> = { kind: 'ok'; data: T } | { kind: 'forbidden' } | { kind: 'missing' };

export async function loadVendor<T>(read: () => Promise<T>, returnTo: string): Promise<Loaded<T>> {
  try {
    return { kind: 'ok', data: await read() };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 403) return { kind: 'forbidden' };
      if (err.status === 404) return { kind: 'missing' };
      if (err.status === 401) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    throw err;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bad id is answered before any API call, with the same not-found as a foreign id. */
export const isUuid = (id: string): boolean => UUID.test(id);
