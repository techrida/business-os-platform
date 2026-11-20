// One plain sentence per access change for the history list. Pure: no React, no server import, so the
// page and its tests share one wording. Never prints a key, an id or the word "scope".
import type {
  AccessCatalogueResponse,
  AccessLevel,
  AccessPermissionKind,
  AccessScope,
  AuditEventDto,
} from '@bos/contracts';

import { LEVEL_LABEL, reachText } from '../roles/_lib/reach';

export const HISTORY_HREF = '/settings/access/history';
export const HISTORY_DENIED_MESSAGE = "You don't have permission to view the access history.";

/** The actions the history shows; any other row of the same entity types is left out. */
export const HISTORY_ACTIONS: ReadonlySet<string> = new Set([
  'access.grant.changed',
  'access.role.reset',
  'access.level_rule.changed',
  'access.assignment_rule.changed',
  'department.member.level_changed',
  'department.created',
  'department.renamed',
  'department.retired',
  'department.restored',
  'department.head.changed',
  'department.member.added',
  'department.member.moved',
  'department.member.removed',
]);

/** Labels from the access catalogue; empty when it could not be read, so the words stay generic. */
export interface HistoryLabels {
  role: (key: string) => string | undefined;
  area: (key: string) => string | undefined;
  permission: (key: string) => { label: string; kind: AccessPermissionKind } | undefined;
}

export const NO_LABELS: HistoryLabels = {
  role: () => undefined,
  area: () => undefined,
  permission: () => undefined,
};

export function labelsFrom(catalogue: AccessCatalogueResponse): HistoryLabels {
  const roles = new Map(catalogue.roles.map((r) => [r.key as string, r.label]));
  const areas = new Map(catalogue.areas.map((a) => [a.key as string, a.label]));
  const permissions = new Map(
    catalogue.permissions.map((p) => [p.key as string, { label: p.label, kind: p.kind }]),
  );
  return {
    role: (key) => roles.get(key),
    area: (key) => areas.get(key),
    permission: (key) => permissions.get(key),
  };
}

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  typeof value === 'object' && value !== null ? (value as Fields) : {};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const SCOPES: readonly string[] = ['assigned', 'own', 'department', 'all', 'customer_org'];
const scopeOf = (value: unknown): AccessScope | null =>
  typeof value === 'string' && SCOPES.includes(value) ? (value as AccessScope) : null;

const LEVELS: readonly string[] = ['staff', 'manager', 'head'];
const levelText = (value: unknown): string | undefined =>
  typeof value === 'string' && LEVELS.includes(value)
    ? LEVEL_LABEL[value as AccessLevel]
    : undefined;

function switchText(who: string, before: unknown, after: unknown): string | null {
  if (typeof after !== 'boolean' || before === after) return null;
  return after ? `${who} now see their department` : `${who} no longer see their department`;
}

/** "Sales: Create and edit leads changed from Their own to Their department." */
export function describeChange(event: AuditEventDto, labels: HistoryLabels): string {
  const before = fields(event.before);
  const after = fields(event.after);
  const roleName = (value: unknown) => {
    const key = text(value);
    return (key === undefined ? undefined : labels.role(key)) ?? 'A role';
  };
  const areaName = (value: unknown) => {
    const key = text(value);
    return (key === undefined ? undefined : labels.area(key)) ?? 'An area';
  };

  switch (event.action) {
    case 'access.grant.changed': {
      const permission = labels.permission(text(after.permission) ?? '');
      const what = permission?.label ?? 'access';
      const kind = permission?.kind ?? 'record';
      const from = reachText(scopeOf(before.scope), kind);
      const to = reachText(scopeOf(after.scope), kind);
      return `${roleName(after.role)}: ${what} changed from ${from} to ${to}.`;
    }
    case 'access.role.reset':
      return `${roleName(before.role ?? after.role)}: access reset to the defaults.`;
    case 'access.level_rule.changed': {
      const changes = [
        switchText('managers', before.managersSeeDepartment, after.managersSeeDepartment),
        switchText('heads', before.headsSeeDepartment, after.headsSeeDepartment),
      ].filter((line): line is string => line !== null);
      const area = areaName(after.area ?? before.area);
      return changes.length > 0
        ? `${area}: ${changes.join(', ')}.`
        : `${area}: department access changed.`;
    }
    case 'access.assignment_rule.changed':
      return `${areaName(after.area ?? before.area)}: who can assign changed.`;
    case 'department.member.level_changed': {
      const department = text(after.departmentName) ?? text(before.departmentName);
      const from = levelText(before.level);
      const to = levelText(after.level);
      const change = from && to ? `from ${from} to ${to}` : 'changed';
      return department
        ? `A member of ${department} changed level ${change}.`
        : `A member changed level ${change}.`;
    }
    case 'department.created': {
      const name = text(after.name);
      return name ? `Department ${name} added.` : 'A department was added.';
    }
    case 'department.renamed': {
      const from = text(before.name);
      const to = text(after.name);
      return from && to ? `Department ${from} renamed to ${to}.` : 'A department was renamed.';
    }
    case 'department.retired':
      return 'A department was retired.';
    case 'department.restored':
      return 'A department was restored.';
    case 'department.head.changed':
      return 'A department head changed.';
    case 'department.member.added':
      return 'A member joined a department.';
    case 'department.member.moved':
      return 'A member moved to another department.';
    case 'department.member.removed':
      return 'A member left a department.';
    default:
      return 'Access changed.';
  }
}

/** The actor's name; a change made by the system or a sign-in service reads "System". */
export function actorName(event: AuditEventDto): string {
  if (event.actorDisplayName) return event.actorDisplayName;
  return event.actorKind === 'user' ? 'Unknown person' : 'System';
}
