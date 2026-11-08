// Permission vocabulary shared by the API (enforcement) and the workspace (what to show).
// Serves the NFR "authorization is deny-by-default": a route needs one of these strings or it is refused.
import { z } from 'zod';

export const PERMISSIONS = [
  'admin.users.read',
  'admin.users.invite',
  'admin.roles.read',
  'admin.roles.write',
  'admin.settings.write',
  'approvals.definitions.read',
  'approvals.definitions.write',
  'approvals.groups.write',
  'approvals.delegations.write',
  'approvals.requests.read',
  'approvals.requests.act',
  'approvals.requests.reroute',
  'documents.upload',
  'documents.read',
  'audit.read',
  'memo.create',
  'memo.read',
  'memo.update',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

/** How far a grant reaches: the user's own records, their department, their customer org, or everything. */
export const SCOPES = ['own', 'department', 'customer_org', 'all'] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const ROLE_KEYS = [
  'founder',
  'management',
  'finance',
  'accountant',
  'sales',
  'customer_user',
  'vendor_user',
] as const;
export const RoleKeySchema = z.enum(ROLE_KEYS);
export type RoleKey = z.infer<typeof RoleKeySchema>;

type RoleGrants = Partial<Record<Permission, Scope>>;

/** Founder gets everything at scope `all`; built from PERMISSIONS so a new permission cannot be forgotten. */
const founderGrants: RoleGrants = Object.fromEntries(PERMISSIONS.map((p) => [p, 'all' as const]));

/** Approvers read and act on every request, and read every memo and document. */
const approverGrants: RoleGrants = {
  'approvals.requests.read': 'all',
  'approvals.requests.act': 'all',
  'memo.read': 'all',
  'documents.read': 'all',
};

/**
 * What each role may do before an admin edits `app.role_permissions`. The seed copies this into
 * the table, so the table (not this constant) is the live truth at runtime.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, RoleGrants> = {
  founder: founderGrants,
  management: { ...approverGrants },
  finance: { ...approverGrants, 'audit.read': 'all' },
  accountant: { ...approverGrants },
  sales: {
    'memo.create': 'own',
    'memo.update': 'own',
    'memo.read': 'own',
    'documents.upload': 'own',
    'documents.read': 'own',
    'approvals.requests.read': 'own',
  },
  customer_user: {},
  vendor_user: {},
};

/** Permissions where the actor must not be someone who prepared the document (separation of duties). */
export const SOD_PERMISSIONS: readonly Permission[] = ['approvals.requests.act'];
