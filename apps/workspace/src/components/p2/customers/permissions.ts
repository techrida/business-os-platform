import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';

type Grants = Record<string, Record<string, unknown> | undefined>;

/**
 * Whether any of the session's roles carries `permission` in its default grants. `session.roles`
 * holds role keys, not permissions, so this reads the defaults the same way `canSeeAdmin` does: a
 * grant an admin adds later in the roles screen does not show here, and the API still enforces it.
 * Server-side only: the browser never decides access.
 */
export function hasPermission(
  roles: readonly string[],
  permission: string,
  grants: Grants = DEFAULT_ROLE_PERMISSIONS,
): boolean {
  return roles.some((role) => {
    if (!Object.hasOwn(grants, role)) return false;
    const granted = grants[role];
    return granted !== undefined && Object.hasOwn(granted, permission);
  });
}

/** `hasPermission` bound to one person's roles: the predicate `visibleGroups` takes. */
export function permissionChecker(
  roles: readonly string[],
  grants?: Grants,
): (permission: string) => boolean {
  return (permission) =>
    grants === undefined
      ? hasPermission(roles, permission)
      : hasPermission(roles, permission, grants);
}
