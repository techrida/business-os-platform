import { DEFAULT_ROLE_PERMISSIONS, type MeResponse, type Permission } from '@bos/contracts';

import type { Grants as LiveGrants } from '@/lib/grants';

type Grants = Record<string, Record<string, unknown> | undefined>;

/** The session's role keys, or the live grants `getGrants` read from `/v1/me`. */
export type PermissionSource = readonly string[] | LiveGrants;

/** Whether `source` is the live grants map rather than a list of role keys. */
export function isLiveGrants(source: PermissionSource): source is LiveGrants {
  return !Array.isArray(source);
}

/**
 * The source to gate on from one `/v1/me` answer (`getMeOrNull` in `lib/live-permissions`): the live grants it
 * reports, the rows Settings > Access edits. Only when that read failed or sent no list do the role keys stand
 * in (built-in defaults), the same outage rule as `permissionsFrom`, so an outage does not shut everyone out.
 */
export function grantsFrom(
  me: Pick<MeResponse, 'permissions'> | null,
  roles: readonly string[],
): PermissionSource {
  if (me?.permissions === undefined) return roles;
  return new Map(me.permissions.map((grant) => [grant.permission, grant.scope]));
}

/**
 * Whether the person holds `permission`. Pass the live grants (`getGrants(session)`): they are the saved role
 * rows the API enforces, so a grant an admin added or removed in Settings > Access shows at once. Role keys
 * (`session.roles`) still work for callers not yet moved, and read the built-in defaults instead, which miss
 * those edits. Server-side only: the browser never decides access, and the API still decides every request.
 */
export function hasPermission(
  source: PermissionSource,
  permission: string,
  grants: Grants = DEFAULT_ROLE_PERMISSIONS,
): boolean {
  if (isLiveGrants(source)) return source.has(permission as Permission);
  return source.some((role) => {
    if (!Object.hasOwn(grants, role)) return false;
    const granted = grants[role];
    return granted !== undefined && Object.hasOwn(granted, permission);
  });
}

/** `hasPermission` bound to one person: the predicate `visibleGroups` takes. */
export function permissionChecker(
  source: PermissionSource,
  grants?: Grants,
): (permission: string) => boolean {
  return (permission) =>
    grants === undefined
      ? hasPermission(source, permission)
      : hasPermission(source, permission, grants);
}
