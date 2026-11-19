// The By role screen's model, built from the API catalogue (spec 6.1). Pure: no React, no server
// import. Every label, group, reach and default comes from the catalogue; nothing here decides access.
import type {
  AccessCatalogueResponse,
  AccessPermissionKind,
  AccessRoleInfo,
  AccessScope,
  GrantChange,
  Permission,
  RoleKey,
} from '@bos/contracts';

import { reachOptions, reachText, type ReachOption } from './reach';

export interface PermissionRow {
  permission: Permission;
  label: string;
  kind: AccessPermissionKind;
  /** A reach `Select`, or a checkbox for an on/off permission and on every portal role row. */
  control: 'select' | 'checkbox';
  /** The reaches the API offers this role for this permission. */
  offered: readonly AccessScope[];
  /** Select choices: "Nothing" plus `offered`. Empty for a checkbox row. */
  options: readonly ReachOption[];
  /** What a ticked checkbox stores: the one reach the API offers. */
  onValue: AccessScope | null;
  saved: AccessScope | null;
  defaultScope: AccessScope | null;
  risk: string | null;
  separationOfDuties: boolean;
}

export interface PermissionGroupView {
  key: string;
  label: string;
  rows: PermissionRow[];
}

/** Unsaved choices, keyed by permission. Holds only values that differ from the saved one. */
export type StagedReach = Readonly<Partial<Record<Permission, AccessScope | null>>>;

const grantKey = (role: RoleKey, permission: Permission) => `${role}\u0000${permission}`;

/**
 * The permission groups for one role in the catalogue's display order. A staff (or Founder) role
 * sees only permissions the API offers staff, so the portal group is absent; a portal role sees only
 * the portal permissions. A grant the role already holds is always shown, even if it is no longer
 * offered, so the screen never hides real access.
 */
export function roleGroups(
  catalogue: AccessCatalogueResponse,
  role: AccessRoleInfo,
): PermissionGroupView[] {
  const info = new Map(catalogue.permissions.map((p) => [p.key, p]));
  const grants = new Map(catalogue.grants.map((g) => [grantKey(g.role, g.permission), g]));
  const portal = role.kind === 'portal';

  const groups: PermissionGroupView[] = [];
  for (const group of catalogue.groups) {
    const rows: PermissionRow[] = [];
    for (const permission of group.permissions) {
      const perm = info.get(permission);
      if (perm === undefined) continue;
      const grant = grants.get(grantKey(role.key, permission));
      const saved = grant?.scope ?? null;
      const offered = portal ? perm.scopesFor.portal : perm.scopesFor.staff;
      if (offered.length === 0 && saved === null) continue;
      const control = !portal && perm.kind === 'record' ? 'select' : 'checkbox';
      rows.push({
        permission,
        label: perm.label,
        kind: portal ? 'portal' : perm.kind,
        control,
        offered,
        options: control === 'select' ? reachOptions(offered, saved) : [],
        onValue: offered[0] ?? saved,
        saved,
        defaultScope: grant?.defaultScope ?? null,
        risk: perm.risk ?? null,
        separationOfDuties: perm.separationOfDuties,
      });
    }
    if (rows.length > 0) groups.push({ key: group.key, label: group.label, rows });
  }
  return groups;
}

/** The value a row shows: the unsaved choice when there is one, else the saved value. */
export function currentReach(row: PermissionRow, staged: StagedReach): AccessScope | null {
  const value = staged[row.permission];
  return value === undefined ? row.saved : value;
}

/** Stage `next` for a row; choosing the saved value again drops the unsaved choice. */
export function stageReach(
  staged: StagedReach,
  row: PermissionRow,
  next: AccessScope | null,
): StagedReach {
  const copy: Partial<Record<Permission, AccessScope | null>> = { ...staged };
  if (next === row.saved) delete copy[row.permission];
  else copy[row.permission] = next;
  return copy;
}

/** One grant change per unsaved choice, in the order the rows appear. */
export function grantChanges(
  role: RoleKey,
  groups: readonly PermissionGroupView[],
  staged: StagedReach,
): GrantChange[] {
  const changes: GrantChange[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      const value = staged[row.permission];
      if (value === undefined || value === row.saved) continue;
      changes.push({ kind: 'grant', role, permission: row.permission, scope: value });
    }
  }
  return changes;
}

/** True when any saved value of the role differs from its default ("Edited"). */
export function isRoleEdited(catalogue: AccessCatalogueResponse, role: RoleKey): boolean {
  return catalogue.grants.some((g) => g.role === role && !g.isDefault);
}

/** True when the value the row shows differs from its default: the undo icon is drawn then. */
export function differsFromDefault(row: PermissionRow, staged: StagedReach): boolean {
  return currentReach(row, staged) !== row.defaultScope;
}

const fold = (value: string) => value.normalize('NFC').toLowerCase();

/**
 * "Find a permission" and "Only show what this role can do". Every typed word must appear in the
 * row's label, its group's label or its note. Groups left with no rows are dropped.
 */
export function filterGroups(
  groups: readonly PermissionGroupView[],
  staged: StagedReach,
  { query, onlyGranted }: { query: string; onlyGranted: boolean },
): PermissionGroupView[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const out: PermissionGroupView[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((row) => {
      if (onlyGranted && currentReach(row, staged) === null) return false;
      if (words.length === 0) return true;
      const haystack = fold([row.label, group.label, row.risk ?? ''].join(' '));
      return words.every((word) => haystack.includes(word));
    });
    if (rows.length > 0) out.push({ ...group, rows });
  }
  return out;
}

/** The undo icon's name: "Reset See leads for Sales to the default: Their own". */
export function undoLabel(roleLabel: string, row: PermissionRow): string {
  return `Reset ${row.label} for ${roleLabel} to the default: ${reachText(row.defaultScope, row.kind)}`;
}

/** Founder first, then staff roles by name; portal roles separately, by name (spec 6.1). */
export function orderRoles(roles: readonly AccessRoleInfo[]): {
  main: AccessRoleInfo[];
  portal: AccessRoleInfo[];
} {
  const byLabel = (a: AccessRoleInfo, b: AccessRoleInfo) => a.label.localeCompare(b.label);
  return {
    main: [
      ...roles.filter((r) => r.kind === 'founder').sort(byLabel),
      ...roles.filter((r) => r.kind === 'staff').sort(byLabel),
    ],
    portal: roles.filter((r) => r.kind === 'portal').sort(byLabel),
  };
}

/** The role page's address. Role keys travel only in URLs, never as visible text. */
export function rolePageHref(role: RoleKey): string {
  return `/settings/access/roles/${encodeURIComponent(role)}`;
}

/** The Users directory filtered to one role ("6 people" opens it). */
export function roleUsersHref(role: RoleKey): string {
  return `/settings/users?role=${encodeURIComponent(role)}`;
}
