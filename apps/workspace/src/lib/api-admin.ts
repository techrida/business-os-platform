import 'server-only';

// Typed, server-only calls to the API's admin routes (users, settings, FX, number series, workflows,
// approval groups, delegations). Serves the NFR "no token in the browser": every call runs in a Server
// Component or Server Action with the user's session, and every response is parsed with Zod so a
// drifting API shape fails loudly here (502) instead of rendering garbage.
//
// Nullable columns are declared nullable so responses from incomplete records still parse.

import {
  type AccessLevel,
  type AdminUsersQuery,
  AdminUsersPageSchema,
  AdminUsersSummarySchema,
  FlaggedUsersSchema,
  SettingKeySchema,
  SettingsPersonSchema,
  type RoleKey,
  type SettingKey,
  type SettingsPerson,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

// ---------------------------------------------------------------------------------------------
// Response shapes (what the controllers actually return)
// ---------------------------------------------------------------------------------------------

const ApprovalPeoplePageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable(),
      email: z.string().nullable(),
    }),
  ),
  nextAfter: z.string().nullable(),
});

const WorkflowVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(['draft', 'published', 'retired']),
  spec: z.unknown(),
  publishedAt: z.string().nullable(),
  /** Who saved the version; null when it was saved before the editor was recorded. Optional for older APIs. */
  createdBy: z.string().nullable().optional(),
  /** The editor's display name from the API, for viewers who cannot read the user directory. */
  createdByName: z.string().nullable().optional(),
  publishedBy: z.string().nullable().optional(),
  /** The caller saved it, so the caller cannot publish it: a second person does (F1-Q11). */
  savedByCaller: z.boolean().optional(),
  /** The caller saved it and nobody else may publish it, so they may, with a reason (F1-Q11 a). */
  publishSoleEligible: z.boolean().optional(),
});
const WorkflowSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  documentType: z.string(),
  currentVersionId: z.string().nullable(),
  versions: z.array(WorkflowVersionSchema),
});

const ApprovalGroupSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  memberUserIds: z.array(z.string()),
});
const DelegationSchema = z.object({
  id: z.string(),
  fromUserId: z.string(),
  toUserId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  documentType: z.string().nullable(),
});

const SettingCurrentSchema = z.object({
  key: SettingKeySchema,
  value: z.unknown(),
  /** null: nobody has saved this key yet, and `value` is the built-in default. */
  version: z.number().int().nullable(),
});
const NumberSeriesSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      fiscalYear: z.string(),
      prefix: z.string(),
      nextValue: z.number(),
      pad: z.number(),
    }),
  ),
});
const FxRatesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      currency: z.string(),
      rateNpr: z.string(),
      rateDate: z.string(),
      source: z.string().nullable(),
      enteredBy: z.string().nullable(),
    }),
  ),
});

const IdSchema = z.object({ id: z.string() });
const VersionNumberSchema = z.object({ version: z.number().int() });

export type { AdminUser } from '@bos/contracts';
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ApprovalGroup = z.infer<typeof ApprovalGroupSchema>;
export type Delegation = z.infer<typeof DelegationSchema>;
export type SettingCurrent = z.infer<typeof SettingCurrentSchema>;
export type NumberSeriesRow = z.infer<typeof NumberSeriesSchema>['items'][number];
export type FxRateRow = z.infer<typeof FxRatesSchema>['items'][number];

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

/** `readBody` in api.ts is private; an empty body (204) and a non-JSON body are both normal here. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request(
  session: Session,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(session, path, init);
  const parsedBody = await readBody(res);
  if (!res.ok)
    throw new ApiError(res.status, `${method} ${path} failed with ${res.status}`, parsedBody);
  return parsedBody;
}

async function requestParsed<S extends z.ZodType>(
  session: Session,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const raw = await request(session, method, path, body);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape we agreed on.
    throw new ApiError(502, `${method} ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** Path segment from user input: a workflow key or setting key must never add a `/` or `?`. */
const seg = (value: string | number): string => encodeURIComponent(String(value));

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/**
 * One page of the staff directory. `total` is every user matching the same filters and search, from the
 * API's `X-Total-Count`; it is null when the header is missing, so a caller never shows a made-up count.
 */
export async function listUsers(
  session: Session,
  q: Partial<AdminUsersQuery> = {},
): Promise<z.infer<typeof AdminUsersPageSchema> & { total: number | null }> {
  const params = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(q)) {
    if (value === undefined) continue;
    // Repeated params (status, role), not a comma-joined string the API would refuse.
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const path = `/v1/admin/users?${params}`;
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
  const parsed = AdminUsersPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  return { ...parsed.data, total };
}

export function summarizeUsers(session: Session) {
  return requestParsed(session, 'GET', '/v1/admin/users/summary', AdminUsersSummarySchema);
}

export async function sendPasswordReset(session: Session, userId: string): Promise<void> {
  await request(session, 'POST', `/v1/admin/users/${seg(userId)}/password-reset`);
}

/** F1-Q5 account actions in Settings > Users; each answers 204, and 409 with a message the page shows. */
export type UserStatusAction = 'deactivate' | 'reactivate' | 'lock' | 'unlock';

export async function changeUserStatus(
  session: Session,
  userId: string,
  action: UserStatusAction,
): Promise<void> {
  await request(session, 'POST', `/v1/admin/users/${seg(userId)}/${action}`);
}

/** People flagged for identity review, with why and when (FU8). Needs the company-wide account grant. */
export function listFlaggedUsers(session: Session) {
  return requestParsed(session, 'GET', '/v1/admin/users/identity-review', FlaggedUsersSchema);
}

/** Resolves one flag: the API reads the identity provider again and answers 204, 409, or 503 with nothing changed. */
export async function resolveUserIdentity(session: Session, userId: string): Promise<void> {
  await request(session, 'POST', `/v1/admin/users/${seg(userId)}/resolve-identity`);
}

/** Complete, caller-scoped picker data. These routes expose no directory administration fields. */
export async function listApprovalPeople(
  session: Session,
  area: 'workflows' | 'approval-groups' | 'delegations',
) {
  const items: z.infer<typeof ApprovalPeoplePageSchema>['items'] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (after) params.set('after', after);
    const page = await requestParsed(
      session,
      'GET',
      `/v1/admin/${area}/people?${params}`,
      ApprovalPeoplePageSchema,
    );
    items.push(...page.items);
    after = page.nextAfter;
    if (after && seen.has(after)) throw new ApiError(502, 'People pagination did not advance');
    if (after) seen.add(after);
  } while (after);
  return items;
}

export function inviteUser(
  session: Session,
  b: {
    email: string;
    givenName: string;
    familyName: string;
    roles: RoleKey[];
    /** F1-Q50: optional placement; both are left out when the form did not ask. */
    departmentId?: string;
    level?: AccessLevel;
  },
): Promise<{ userId: string }> {
  return requestParsed(
    session,
    'POST',
    '/v1/admin/users/invite',
    z.object({ userId: z.string() }),
    b,
  );
}

export async function setUserRoles(
  session: Session,
  userId: string,
  roles: RoleKey[],
): Promise<void> {
  await request(session, 'PUT', `/v1/admin/users/${seg(userId)}/roles`, { roles });
}

// ---------------------------------------------------------------------------------------------
// Settings, number series, FX rates
// ---------------------------------------------------------------------------------------------

export function getSetting(session: Session, key: SettingKey): Promise<SettingCurrent> {
  return requestParsed(session, 'GET', `/v1/admin/settings/${seg(key)}`, SettingCurrentSchema);
}

/** The people the Lead owner card may pick: read with the setting's own permission, not lead access. */
export function listDefaultLeadOwnerPeople(session: Session): Promise<SettingsPerson[]> {
  return requestParsed(
    session,
    'GET',
    '/v1/admin/settings/crm.default_lead_owner/people',
    SettingsPersonSchema.array(),
  );
}

/**
 * The saved default reminder and escalation times (`approvals.sla_defaults`). Readable by anyone who
 * may edit approval workflows, unlike `getSetting`, which needs the settings admin permission.
 */
export function getApprovalSlaDefaults(session: Session): Promise<SettingCurrent> {
  return requestParsed(session, 'GET', '/v1/admin/approval-sla-defaults', SettingCurrentSchema);
}

export function putSetting(
  session: Session,
  key: SettingKey,
  value: unknown,
  /** The version the screen loaded (`null` when it loaded the default). A newer saved version makes the API answer 409. */
  expectedVersion?: number | null,
): Promise<{ version: number }> {
  return requestParsed(session, 'PUT', `/v1/admin/settings/${seg(key)}`, VersionNumberSchema, {
    value,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
}

export async function listNumberSeries(session: Session): Promise<NumberSeriesRow[]> {
  const res = await requestParsed(session, 'GET', '/v1/admin/number-series', NumberSeriesSchema);
  return res.items;
}

export async function listFxRates(
  session: Session,
  q: { currency?: 'INR' | 'USD'; limit?: number } = {},
): Promise<FxRateRow[]> {
  const params = new URLSearchParams({ limit: String(q.limit ?? 50) });
  if (q.currency) params.set('currency', q.currency);
  const res = await requestParsed(
    session,
    'GET',
    `/v1/admin/fx-rates?${params.toString()}`,
    FxRatesSchema,
  );
  return res.items;
}

export function addFxRate(
  session: Session,
  b: { currency: 'INR' | 'USD'; rateNpr: string; rateDate: string; source: string },
): Promise<{ id: string }> {
  return requestParsed(session, 'POST', '/v1/admin/fx-rates', IdSchema, b);
}

// ---------------------------------------------------------------------------------------------
// Workflows (definitions and versions)
// ---------------------------------------------------------------------------------------------

export function listWorkflows(session: Session): Promise<Workflow[]> {
  return requestParsed(session, 'GET', '/v1/admin/workflows', z.array(WorkflowSchema));
}

/** A new definition with version 1 as a draft. The body is strict: exactly key, name and spec. */
export function createWorkflow(
  session: Session,
  b: { key: string; name: string; spec: unknown },
): Promise<WorkflowVersion> {
  return requestParsed(session, 'POST', '/v1/admin/workflows', WorkflowVersionSchema, {
    key: b.key,
    name: b.name,
    spec: b.spec,
  });
}

/**
 * There is no route that edits a draft in place: this adds the next version number as a new draft.
 * The body is strict (`{ spec }` only), and spec.documentType must match the definition's.
 */
export function addWorkflowVersion(
  session: Session,
  key: string,
  spec: unknown,
): Promise<WorkflowVersion> {
  return requestParsed(
    session,
    'POST',
    `/v1/admin/workflows/${seg(key)}/versions`,
    WorkflowVersionSchema,
    { spec },
  );
}

export function publishWorkflowVersion(
  session: Session,
  key: string,
  version: number,
  /** Only for the small-team rule (F1-Q11 a); the usual second-person publish sends no body. */
  reason?: string,
): Promise<WorkflowVersion> {
  return requestParsed(
    session,
    'POST',
    `/v1/admin/workflows/${seg(key)}/versions/${seg(version)}/publish`,
    WorkflowVersionSchema,
    reason === undefined ? undefined : { reason },
  );
}

// ---------------------------------------------------------------------------------------------
// Approval groups
// ---------------------------------------------------------------------------------------------

export function listApprovalGroups(session: Session): Promise<ApprovalGroup[]> {
  return requestParsed(session, 'GET', '/v1/admin/approval-groups', z.array(ApprovalGroupSchema));
}

export function createApprovalGroup(
  session: Session,
  b: { key: string; name: string },
): Promise<{ id: string }> {
  return requestParsed(session, 'POST', '/v1/admin/approval-groups', IdSchema, {
    key: b.key,
    name: b.name,
  });
}

export async function deleteApprovalGroup(session: Session, id: string): Promise<void> {
  await request(session, 'DELETE', `/v1/admin/approval-groups/${seg(id)}`);
}

export async function addApprovalGroupMember(
  session: Session,
  groupId: string,
  userId: string,
): Promise<void> {
  await request(session, 'POST', `/v1/admin/approval-groups/${seg(groupId)}/members`, { userId });
}

export async function removeApprovalGroupMember(
  session: Session,
  groupId: string,
  userId: string,
): Promise<void> {
  await request(
    session,
    'DELETE',
    `/v1/admin/approval-groups/${seg(groupId)}/members/${seg(userId)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------------------------

export function listDelegations(session: Session): Promise<Delegation[]> {
  return requestParsed(session, 'GET', '/v1/admin/delegations', z.array(DelegationSchema));
}

/** `startsAt` and `endsAt` must be ISO 8601 with an offset (the API rejects a bare local time). */
export function createDelegation(
  session: Session,
  b: {
    fromUserId: string;
    toUserId: string;
    startsAt: string;
    endsAt: string;
    documentType: string | null;
  },
): Promise<{ id: string }> {
  return requestParsed(session, 'POST', '/v1/admin/delegations', IdSchema, b);
}

export async function revokeDelegation(session: Session, id: string): Promise<void> {
  await request(session, 'DELETE', `/v1/admin/delegations/${seg(id)}`);
}
