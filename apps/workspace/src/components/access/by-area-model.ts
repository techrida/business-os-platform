// Pure rules for Access > By area (spec 3 and 4): what each control shows, what is staged, which
// changes a card sends to the review dialog, and the wording of the undo icons. Everything reads
// the API catalogue; nothing here decides access (the server does, in its dry run).
import type {
  AccessAreaInfo,
  AccessAssignmentRule,
  AccessCatalogueResponse,
  AccessChange,
  AccessPermissionInfo,
  AccessRoleInfo,
  AccessScope,
  AccessWarning,
  AssignmentHandOverInput,
  ManagerAssignmentRule,
  RoleKey,
  StaffAssignmentRule,
} from '@bos/contracts';

export const REACH_TEXT: Record<AccessScope | 'none', { label: string; hint: string }> = {
  none: { label: 'Nothing', hint: 'Cannot open this area.' },
  assigned: {
    label: 'Only work given to them',
    hint: 'Records they were assigned a task on. Read only.',
  },
  own: { label: 'Their own', hint: 'Records they created or own.' },
  department: { label: 'Their department', hint: 'Records owned by anyone in their department.' },
  all: { label: 'Everything', hint: 'Every record in the company.' },
  customer_org: { label: "Their own company's records", hint: 'Portal users only.' },
};

/** Staff reach options in the order of spec 3.2 (Nothing comes first and is always offered). */
const STAFF_REACH_ORDER: readonly AccessScope[] = ['assigned', 'own', 'department', 'all'];

export const STAFF_RULE_TEXT: Record<StaffAssignmentRule, string> = {
  self_and_peers: 'Themselves and same-level colleagues in their department',
  self_only: 'Only themselves',
  any_at_or_below: 'Anyone in their department at or below their level',
};
export const STAFF_RULE_ORDER: readonly StaffAssignmentRule[] = [
  'self_and_peers',
  'self_only',
  'any_at_or_below',
];

export const MANAGER_RULE_TEXT: Record<ManagerAssignmentRule, string> = {
  any_at_or_below: 'Anyone in their department at or below their level',
  self_and_staff: 'Only themselves and people below their level',
};
export const MANAGER_RULE_ORDER: readonly ManagerAssignmentRule[] = [
  'any_at_or_below',
  'self_and_staff',
];

export const STAFF_RULE_OPTIONS = STAFF_RULE_ORDER.map((key) => ({
  value: key,
  label: STAFF_RULE_TEXT[key],
}));
export const MANAGER_RULE_OPTIONS = MANAGER_RULE_ORDER.map((key) => ({
  value: key,
  label: MANAGER_RULE_TEXT[key],
}));

export const STALE_MESSAGE = 'Access was changed by someone else. Reload to see the latest.';

export const MANAGERS_LINE = 'Managers also see their whole department';
export const HEADS_LINE = 'Department heads also see their whole department';

export function reachLabel(scope: AccessScope | null): string {
  return REACH_TEXT[scope ?? 'none'].label;
}

export function reachHint(scope: AccessScope | null): string {
  return REACH_TEXT[scope ?? 'none'].hint;
}

export function peopleLabel(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

/** Staff roles in the catalogue's order. Founder and portal roles never appear in an area card. */
export function staffRoles(catalogue: AccessCatalogueResponse): AccessRoleInfo[] {
  return catalogue.roles.filter((role) => role.kind === 'staff');
}

export function founderRole(catalogue: AccessCatalogueResponse): AccessRoleInfo | undefined {
  return catalogue.roles.find((role) => role.kind === 'founder');
}

export function permissionInfo(
  catalogue: AccessCatalogueResponse,
  key: string,
): AccessPermissionInfo | undefined {
  return catalogue.permissions.find((permission) => permission.key === key);
}

interface GrantValue {
  scope: AccessScope | null;
  defaultScope: AccessScope | null;
}

export function grantFor(
  catalogue: AccessCatalogueResponse,
  role: RoleKey,
  permission: string,
): GrantValue {
  const row = catalogue.grants.find((g) => g.role === role && g.permission === permission);
  return { scope: row?.scope ?? null, defaultScope: row?.defaultScope ?? null };
}

/** The choices of the reach Select: Nothing, then only the staff scopes the API lists. */
export function reachChoices(
  permission: AccessPermissionInfo | undefined,
  current: AccessScope | null,
): { value: string; label: string }[] {
  const allowed = new Set(permission?.scopesFor.staff ?? []);
  const scopes = STAFF_REACH_ORDER.filter((scope) => allowed.has(scope));
  // A saved value the API no longer offers is still shown, so the Select never misreads it.
  if (current !== null && !scopes.includes(current)) scopes.push(current);
  return [
    { value: '', label: REACH_TEXT.none.label },
    ...scopes.map((scope) => ({ value: scope, label: reachLabel(scope) })),
  ];
}

export function scopeFromValue(value: string): AccessScope | null {
  return value === '' ? null : (value as AccessScope);
}

export interface AssignmentDraft {
  staff: StaffAssignmentRule;
  managers: ManagerAssignmentRule;
  handOvers: AssignmentHandOverInput[];
}

/** Everything one area card can stage. */
export interface AreaDraft {
  reach: Partial<Record<RoleKey, AccessScope | null>>;
  managers: boolean;
  heads: boolean;
  assignment: AssignmentDraft | null;
}

export function assignmentRuleFor(
  catalogue: AccessCatalogueResponse,
  area: AccessAreaInfo,
): AccessAssignmentRule | undefined {
  if (!area.hasAssignment) return undefined;
  return catalogue.assignment.find((rule) => rule.area === area.key);
}

const pairs = (list: readonly AssignmentHandOverInput[]): AssignmentHandOverInput[] =>
  list.map(({ fromDepartmentId, toDepartmentId }) => ({ fromDepartmentId, toDepartmentId }));

function levelRuleFor(catalogue: AccessCatalogueResponse, area: AccessAreaInfo) {
  return catalogue.levelRules.find((rule) => rule.area === area.key);
}

/** The saved values of one area, as the card starts editing them. */
export function savedDraft(catalogue: AccessCatalogueResponse, area: AccessAreaInfo): AreaDraft {
  const reach: AreaDraft['reach'] = {};
  for (const role of staffRoles(catalogue)) {
    reach[role.key] = grantFor(catalogue, role.key, area.seePermission).scope;
  }
  const level = levelRuleFor(catalogue, area);
  const rule = assignmentRuleFor(catalogue, area);
  return {
    reach,
    managers: level?.managersSeeDepartment ?? false,
    heads: level?.headsSeeDepartment ?? false,
    assignment: rule
      ? { staff: rule.staff, managers: rule.managers, handOvers: pairs(rule.handOvers) }
      : null,
  };
}

/** The defaults of one area (D32): what every undo icon goes back to. */
export function defaultDraft(catalogue: AccessCatalogueResponse, area: AccessAreaInfo): AreaDraft {
  const reach: AreaDraft['reach'] = {};
  for (const role of staffRoles(catalogue)) {
    reach[role.key] = grantFor(catalogue, role.key, area.seePermission).defaultScope;
  }
  const level = levelRuleFor(catalogue, area);
  const rule = assignmentRuleFor(catalogue, area);
  return {
    reach,
    managers: level?.defaults.managersSeeDepartment ?? false,
    heads: level?.defaults.headsSeeDepartment ?? false,
    assignment: rule
      ? {
          staff: rule.defaults.staff,
          managers: rule.defaults.managers,
          handOvers: pairs(rule.defaults.handOvers),
        }
      : null,
  };
}

const pairKey = (pair: AssignmentHandOverInput) =>
  `${pair.fromDepartmentId}>${pair.toDepartmentId}`;

export function sameHandOvers(
  a: readonly AssignmentHandOverInput[],
  b: readonly AssignmentHandOverInput[],
): boolean {
  const left = a.map(pairKey).sort();
  const right = b.map(pairKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** One control of an area card, for the undo icons. */
export type AreaControl =
  | { type: 'reach'; role: RoleKey }
  | { type: 'managers' }
  | { type: 'heads' }
  | { type: 'staffRule' }
  | { type: 'managerRule' }
  | { type: 'handOvers' };

export function controlMatches(a: AreaDraft, b: AreaDraft, control: AreaControl): boolean {
  switch (control.type) {
    case 'reach':
      return (a.reach[control.role] ?? null) === (b.reach[control.role] ?? null);
    case 'managers':
      return a.managers === b.managers;
    case 'heads':
      return a.heads === b.heads;
    case 'staffRule':
      return a.assignment?.staff === b.assignment?.staff;
    case 'managerRule':
      return a.assignment?.managers === b.assignment?.managers;
    case 'handOvers':
      return sameHandOvers(a.assignment?.handOvers ?? [], b.assignment?.handOvers ?? []);
  }
}

/** True when `a` and `b` are the same control of a card. */
export function sameControl(a: AreaControl, b: AreaControl): boolean {
  if (a.type === 'reach' || b.type === 'reach') {
    return a.type === 'reach' && b.type === 'reach' && a.role === b.role;
  }
  return a.type === b.type;
}

/** A value the server refused on save, tied to the card control that staged it. */
export interface RefusedControl {
  control: AreaControl;
  message: string;
}

/** The card controls one sent change came from. */
function controlsOfChange(change: AccessChange): AreaControl[] {
  switch (change.kind) {
    case 'grant':
      return [{ type: 'reach', role: change.role }];
    case 'levelRule':
      return [
        ...(change.managersSeeDepartment !== undefined ? [{ type: 'managers' } as const] : []),
        ...(change.headsSeeDepartment !== undefined ? [{ type: 'heads' } as const] : []),
      ];
    case 'assignment':
      return [
        ...(change.staff !== undefined ? [{ type: 'staffRule' } as const] : []),
        ...(change.managers !== undefined ? [{ type: 'managerRule' } as const] : []),
        ...(change.handOvers !== undefined ? [{ type: 'handOvers' } as const] : []),
      ];
    default:
      return [];
  }
}

/**
 * Ties a refused save back to the controls: the server names each refused change as
 * `changes.<index>` (optionally `.scope`, `.area`, `.handOvers.<n>`) in its field errors, or by
 * `changeIndex` on a blocked warning. `changes` is exactly what was sent, so the index reads it.
 * The first reason for a control wins.
 */
export function refusedControls(
  changes: readonly AccessChange[],
  fieldErrors: Readonly<Record<string, string>> | undefined,
  warnings: readonly AccessWarning[] | undefined,
): RefusedControl[] {
  const refused: RefusedControl[] = [];
  const add = (index: number, message: string, only?: AreaControl['type']) => {
    const change = changes[index];
    if (!change) return;
    for (const control of controlsOfChange(change)) {
      if (only !== undefined && control.type !== only) continue;
      if (refused.some((r) => sameControl(r.control, control))) continue;
      refused.push({ control, message });
    }
  };
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    const match = /^changes\.(\d+)(?:\.(\w+))?/.exec(key);
    if (!match) continue;
    add(Number(match[1]), message, match[2] === 'handOvers' ? 'handOvers' : undefined);
  }
  for (const warning of warnings ?? []) {
    if (warning.severity === 'blocked' && warning.changeIndex !== undefined) {
      add(warning.changeIndex, warning.message);
    }
  }
  return refused;
}

/** The draft with one control put back to its value in `source` (the defaults, for an undo). */
export function withControlFrom(
  draft: AreaDraft,
  source: AreaDraft,
  control: AreaControl,
): AreaDraft {
  switch (control.type) {
    case 'reach':
      return {
        ...draft,
        reach: { ...draft.reach, [control.role]: source.reach[control.role] ?? null },
      };
    case 'managers':
      return { ...draft, managers: source.managers };
    case 'heads':
      return { ...draft, heads: source.heads };
    case 'staffRule':
    case 'managerRule':
    case 'handOvers': {
      if (!draft.assignment || !source.assignment) return draft;
      const next = { ...draft.assignment };
      if (control.type === 'staffRule') next.staff = source.assignment.staff;
      if (control.type === 'managerRule') next.managers = source.assignment.managers;
      if (control.type === 'handOvers') next.handOvers = pairs(source.assignment.handOvers);
      return { ...draft, assignment: next };
    }
  }
}

/**
 * The changes that turn `saved` into `draft`, in the contract's shape. Only what differs is sent:
 * a save never touches a value the person did not change.
 */
export function areaChanges(
  catalogue: AccessCatalogueResponse,
  area: AccessAreaInfo,
  saved: AreaDraft,
  draft: AreaDraft,
): AccessChange[] {
  const changes: AccessChange[] = [];
  for (const role of staffRoles(catalogue)) {
    const before = saved.reach[role.key] ?? null;
    const after = draft.reach[role.key] ?? null;
    if (before !== after) {
      changes.push({ kind: 'grant', role: role.key, permission: area.seePermission, scope: after });
    }
  }
  const levelChanged = saved.managers !== draft.managers || saved.heads !== draft.heads;
  if (area.supportsDepartment && levelChanged) {
    changes.push({
      kind: 'levelRule',
      area: area.key,
      ...(saved.managers !== draft.managers ? { managersSeeDepartment: draft.managers } : {}),
      ...(saved.heads !== draft.heads ? { headsSeeDepartment: draft.heads } : {}),
    });
  }
  const rule = assignmentRuleFor(catalogue, area);
  if (rule && saved.assignment && draft.assignment) {
    const staffChanged = saved.assignment.staff !== draft.assignment.staff;
    const managersChanged = saved.assignment.managers !== draft.assignment.managers;
    const handOversChanged = !sameHandOvers(saved.assignment.handOvers, draft.assignment.handOvers);
    if (staffChanged || managersChanged || handOversChanged) {
      changes.push({
        kind: 'assignment',
        area: rule.area,
        ...(staffChanged ? { staff: draft.assignment.staff } : {}),
        ...(managersChanged ? { managers: draft.assignment.managers } : {}),
        ...(handOversChanged ? { handOvers: pairs(draft.assignment.handOvers) } : {}),
      });
    }
  }
  return changes;
}

/** True when any saved value of the area differs from its default: the "Edited" badge. */
export function isAreaEdited(catalogue: AccessCatalogueResponse, area: AccessAreaInfo): boolean {
  const changes = areaChanges(
    catalogue,
    area,
    defaultDraft(catalogue, area),
    savedDraft(catalogue, area),
  );
  return changes.length > 0;
}

/** "Reset Sales on Leads to the default: Their own" (spec 4, acceptance criterion 8). */
export function undoName(subject: string, areaLabel: string, defaultText: string): string {
  return `Reset ${subject} on ${areaLabel} to the default: ${defaultText}`;
}

export function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

/** The action permissions of an area that a role holds, as their catalogue labels. */
export function actionLabels(
  catalogue: AccessCatalogueResponse,
  area: AccessAreaInfo,
  role: RoleKey,
): string[] {
  return area.actionPermissions
    .filter((permission) => grantFor(catalogue, role, permission).scope !== null)
    .map((permission) => permissionInfo(catalogue, permission)?.label)
    .filter((label): label is string => typeof label === 'string' && label.length > 0);
}

/** Staff roles split as in spec 4: those with access first, the rest behind a disclosure. */
export function splitByAccess(
  roles: readonly AccessRoleInfo[],
  saved: AreaDraft,
): { withAccess: AccessRoleInfo[]; withoutAccess: AccessRoleInfo[] } {
  const withAccess: AccessRoleInfo[] = [];
  const withoutAccess: AccessRoleInfo[] = [];
  for (const role of roles) {
    if ((saved.reach[role.key] ?? null) === null) withoutAccess.push(role);
    else withAccess.push(role);
  }
  return { withAccess, withoutAccess };
}
