import 'server-only';

import { DEFAULT_ROLE_PERMISSIONS, type MeResponse } from '@bos/contracts';
import { cache } from 'react';

import { getMe } from './api';
import type { Session } from './session';

/** One `GET /v1/me` per render (React `cache` keys on the access token); null when it fails. */
export const getMeOrNull = cache(async (accessToken: string): Promise<MeResponse | null> => {
  try {
    return await getMe({ accessToken });
  } catch {
    return null;
  }
});

function roleDefaults(roles: readonly string[]): readonly string[] {
  const defaults = DEFAULT_ROLE_PERMISSIONS as Record<string, object | undefined>;
  return [
    ...new Set(
      roles.flatMap((role) => {
        const granted = Object.hasOwn(defaults, role) ? defaults[role] : undefined;
        return granted === undefined ? [] : Object.keys(granted);
      }),
    ),
  ];
}

/**
 * The permissions to gate on: the live grants `/v1/me` reports (the rows Settings > Access edits, which the API
 * enforces). Only when that read fails or sends no list do the built-in role defaults stand in, so an outage
 * does not shut everyone out. The API still decides every request.
 */
export function permissionsFrom(
  me: Pick<MeResponse, 'permissions'> | null,
  roles: readonly string[],
): readonly string[] {
  if (me?.permissions === undefined) return roleDefaults(roles);
  return [...new Set(me.permissions.map((grant) => grant.permission))];
}

/** `permissionsFrom` for the session user. Server-side only. */
export async function getPermissions(
  session: Pick<Session, 'accessToken' | 'roles'>,
): Promise<readonly string[]> {
  return permissionsFrom(await getMeOrNull(session.accessToken), session.roles);
}

/** `getPermissions` as the predicate the nav and settings helpers take. */
export async function getPermissionCheck(
  session: Pick<Session, 'accessToken' | 'roles'>,
): Promise<(permission: string) => boolean> {
  const held = new Set(await getPermissions(session));
  return (permission) => held.has(permission);
}
