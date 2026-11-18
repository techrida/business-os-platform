import 'server-only';

import { failureOf, getMemo, getMemoDirectory } from './api-kernel';
import type { MemoDraftScopeId } from './memo-working-draft-types';
import type { Session } from './session';

/**
 * Who may keep a working copy for a scope. The working copy is stored under the caller's own identity, so this is not
 * about other people's data; it stops an account from parking content against a memo it may not edit, and keeps the
 * draft routes from becoming a side door around the memo's own rules (private drafts, 83ed5d85).
 *
 * Both answers come from the API on every call, never from the browser:
 * - New memo: `GET /v1/test-memos/directory`, which the API serves only to a caller holding `memo.create`.
 * - A memo: `GET /v1/test-memos/:id` must succeed with `canUpdate` (a draft or returned memo the caller's grants let
 *   them edit), and the memo's owner must be the caller, taken from the directory's `currentUserId`.
 *
 * Anything that fails or is unclear is a denial (fail closed). `delete` skips only `canUpdate`: once a memo is
 * submitted its working copy has to be purged by its creator, and deleting your own working copy discloses nothing.
 */
export type DraftOperation = 'read' | 'write' | 'delete';

export interface DraftDenial {
  status: 401 | 403 | 404 | 502;
  message: string;
}

const DENIED_403: DraftDenial = {
  status: 403,
  message: 'You cannot keep a draft for this memo.',
};
const NOT_FOUND: DraftDenial = { status: 404, message: 'That memo was not found.' };
const UNCHECKED: DraftDenial = {
  status: 502,
  message: 'Your access could not be checked right now. Nothing was saved.',
};
const SIGNED_OUT: DraftDenial = { status: 401, message: 'Sign in to continue.' };

/** Maps an API failure to a denial. A 5xx, a timeout or a bad body is "could not check", never "allowed". */
function denialOf(err: unknown): DraftDenial {
  const { status } = failureOf(err);
  if (status === 401) return SIGNED_OUT;
  if (status === 403) return DENIED_403;
  if (status === 404) return NOT_FOUND;
  return UNCHECKED;
}

/** `null` when the caller may do `operation` on the scope, otherwise why not. */
export async function authorizeDraftScope(
  session: Session,
  scopeId: MemoDraftScopeId,
  operation: DraftOperation,
): Promise<DraftDenial | null> {
  if (scopeId === null) {
    try {
      await getMemoDirectory(session);
      return null;
    } catch (err) {
      return denialOf(err);
    }
  }

  let memo;
  try {
    memo = await getMemo(session, scopeId);
  } catch (err) {
    return denialOf(err);
  }
  let currentUserId: string;
  try {
    currentUserId = (await getMemoDirectory(session)).currentUserId;
  } catch (err) {
    return denialOf(err);
  }
  if (memo.ownerUserId !== currentUserId) return NOT_FOUND;
  if (operation !== 'delete' && !memo.canUpdate) {
    return { status: 403, message: 'This memo can no longer be edited.' };
  }
  return null;
}
