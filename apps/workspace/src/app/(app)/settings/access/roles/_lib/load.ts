import 'server-only';

import type { AccessCatalogueResponse } from '@bos/contracts';

import { ACCESS_LOAD_ERROR_MESSAGE, getAccessCatalogue } from '@/lib/api-access';
import type { Session } from '@/lib/session';

import { isForbidden } from '../../../admin-errors';

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

export const ACCESS_VIEW_DENIED_MESSAGE = "You don't have permission to view access settings.";

/**
 * A failed read becomes one plain sentence (spec 4 "Load error", review R7): a refusal says so,
 * anything else is the generic "could not load" line, never a status code or the word API.
 */
export function loadErrorMessage(error: unknown): string {
  return isForbidden(error) ? ACCESS_VIEW_DENIED_MESSAGE : ACCESS_LOAD_ERROR_MESSAGE;
}

export async function loadCatalogue(session: Session): Promise<Loaded<AccessCatalogueResponse>> {
  try {
    return { ok: true, data: await getAccessCatalogue(session) };
  } catch (error) {
    return { ok: false, message: loadErrorMessage(error) };
  }
}
