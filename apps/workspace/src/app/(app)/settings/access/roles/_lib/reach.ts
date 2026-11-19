// How far a permission reaches, in words (spec 3.2). Pure: no React, no server import, so the pages,
// the editor and the tests share one wording. The screen never says "scope".
import type { AccessLevel, AccessPermissionKind, AccessScope } from '@bos/contracts';

/** Display order of the reach options, narrowest first. */
const REACH_ORDER: readonly AccessScope[] = [
  'assigned',
  'own',
  'department',
  'all',
  'customer_org',
];

export const REACH_LABEL: Readonly<Record<AccessScope, string>> = {
  assigned: 'Only work given to them',
  own: 'Their own',
  department: 'Their department',
  all: 'Everything',
  customer_org: "Their own company's records",
};

const REACH_HINT: Readonly<Record<AccessScope, string>> = {
  assigned: 'Records they were assigned a task on. Read only.',
  own: 'Records they created or own.',
  department: 'Records owned by anyone in their department.',
  all: 'Every record in the company.',
  customer_org: 'Records of their own company only.',
};

export const NOTHING_LABEL = 'Nothing';

/** The value the reach `Select` uses for "Nothing" (no grant). */
export const NOTHING_VALUE = '';

/** "Their own", "Nothing"; an on/off permission reads "On" or "Off". */
export function reachText(scope: AccessScope | null, kind: AccessPermissionKind): string {
  if (kind === 'onOff') return scope === null ? 'Off' : 'On';
  return scope === null ? NOTHING_LABEL : REACH_LABEL[scope];
}

/** One line under a reach control saying what the chosen reach means. */
export function reachHint(scope: AccessScope | null): string {
  return scope === null ? 'No access.' : REACH_HINT[scope];
}

export interface ReachOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * The reach choices for one permission: "Nothing" plus exactly the reaches the API offers, in
 * spec order. A saved value the API no longer offers stays visible as a disabled option, so the
 * control shows the truth instead of a blank, but it cannot be chosen again.
 */
export function reachOptions(
  offered: readonly AccessScope[],
  current: AccessScope | null,
): ReachOption[] {
  const options: ReachOption[] = [{ value: NOTHING_VALUE, label: NOTHING_LABEL }];
  for (const scope of REACH_ORDER) {
    if (offered.includes(scope)) options.push({ value: scope, label: REACH_LABEL[scope] });
  }
  if (current !== null && !offered.includes(current)) {
    options.push({ value: current, label: REACH_LABEL[current], disabled: true });
  }
  return options;
}

/** The Select's string back to a reach; anything unknown reads as "Nothing". */
export function reachFromValue(value: string, offered: readonly AccessScope[]): AccessScope | null {
  return (offered as readonly string[]).includes(value) ? (value as AccessScope) : null;
}

export const LEVEL_LABEL: Readonly<Record<AccessLevel, string>> = {
  staff: 'Staff',
  manager: 'Manager',
  head: 'Head',
};

/** "1 person", "6 people". */
export function peopleText(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}
