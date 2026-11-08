import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';

/**
 * The P2 permissions the customer and verification screens ask about. They are plain strings, not
 * the contracts' `Permission` type: K3 adds them to the contracts, and until it lands on this
 * branch they are not in `DEFAULT_ROLE_PERMISSIONS`, so every check below answers "no" (deny by
 * default). The nav and the write and review buttons stay hidden until then; the API still
 * decides every call.
 */
export type P2Permission =
  'customer.read' | 'customer.write' | 'verification.read' | 'verification.review';

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
