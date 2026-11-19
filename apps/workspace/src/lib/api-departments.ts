import 'server-only';

// Typed, server-only calls to the Departments admin API (/v1/admin/departments, spec 5 and 7.4).
// Every response is validated with Zod so a drifting API shape fails as 502. Failures of a write
// are turned into a typed result the Departments screens can show (stale, invalid with field
// messages, not found, other).

import {
  type AdminDepartmentDetail,
  AdminDepartmentDetailSchema,
  type AdminDepartmentList,
  AdminDepartmentListSchema,
  AdminUsersPageSchema,
  type CreateDepartmentBody,
  type DepartmentChange,
  type DepartmentStatus,
  type RenameDepartmentBody,
  type RestoreDepartmentBody,
  type RetireDepartmentBody,
  type RoleKey,
  type UnassignedPeopleResponse,
  UnassignedPeopleResponseSchema,
  type UpdateDepartmentPeopleResponse,
  UpdateDepartmentPeopleResponseSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

export const DEPARTMENT_STALE_MESSAGE =
  'This department was changed by someone else. Reload to see the latest.';
export const DEPARTMENT_ACCESS_STALE_MESSAGE =
  'Access was changed by someone else. Reload to see the latest.';
export const DEPARTMENT_SAVE_ERROR_MESSAGE =
  'The department could not be saved. Try again in a moment.';
export const DEPARTMENT_FORBIDDEN_MESSAGE = 'Only a Founder can change departments.';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a value the API's `ParseUUIDPipe` accepts. Anything else would answer 400, not 404. */
export function isDepartmentId(value: string): boolean {
  return GUID.test(value);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function requestParsed<S extends z.ZodType>(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(session, path, init);
  const raw = await readBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, `${method} ${path} failed with ${res.status}`, raw);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(502, `${method} ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

export interface DepartmentListQuery {
  q?: string | undefined;
  /** Empty means the API default (active only). */
  status?: readonly DepartmentStatus[] | undefined;
}

/** `GET /v1/admin/departments` with `q` and repeated `status` params. */
export function listDepartments(
  session: Session,
  query: DepartmentListQuery = {},
): Promise<AdminDepartmentList> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const status of query.status ?? []) params.append('status', status);
  const search = params.toString();
  return requestParsed(
    session,
    'GET',
    `/v1/admin/departments${search ? `?${search}` : ''}`,
    AdminDepartmentListSchema,
  );
}

/** `GET /v1/admin/departments/unassigned`: active staff who belong to no department. */
export function listUnassignedPeople(
  session: Session,
  q?: string,
): Promise<UnassignedPeopleResponse> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const search = params.toString();
  return requestParsed(
    session,
    'GET',
    `/v1/admin/departments/unassigned${search ? `?${search}` : ''}`,
    UnassignedPeopleResponseSchema,
  );
}

/**
 * `GET /v1/admin/departments/:id`. Returns null for an id that is not a GUID, an unknown or
 * other-company department (404) and a department the caller may not open (403), so the page shows
 * one "could not be found" screen for all of them.
 */
export async function getDepartment(
  session: Session,
  id: string,
): Promise<AdminDepartmentDetail | null> {
  if (!isDepartmentId(id)) return null;
  try {
    return await requestParsed(
      session,
      'GET',
      `/v1/admin/departments/${encodeURIComponent(id)}`,
      AdminDepartmentDetailSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** `POST /v1/admin/departments`. */
export function createDepartment(
  session: Session,
  body: CreateDepartmentBody,
): Promise<AdminDepartmentDetail> {
  const payload: CreateDepartmentBody = {
    name: body.name,
    ...(body.headUserId !== undefined ? { headUserId: body.headUserId } : {}),
  };
  return requestParsed(
    session,
    'POST',
    '/v1/admin/departments',
    AdminDepartmentDetailSchema,
    payload,
  );
}

/** `PATCH /v1/admin/departments/:id` (rename), guarded by the department's version. */
export function renameDepartment(
  session: Session,
  id: string,
  body: RenameDepartmentBody,
): Promise<AdminDepartmentDetail> {
  return requestParsed(
    session,
    'PATCH',
    `/v1/admin/departments/${encodeURIComponent(id)}`,
    AdminDepartmentDetailSchema,
    { name: body.name, expectedVersion: body.expectedVersion },
  );
}

/**
 * `POST /v1/admin/departments/:id/retire`. `moveMembersTo` is sent only when given: an id moves
 * the members there, `null` leaves them with no department, leaving it out is only valid for an
 * empty department.
 */
export function retireDepartment(
  session: Session,
  id: string,
  body: RetireDepartmentBody,
): Promise<AdminDepartmentDetail> {
  return requestParsed(
    session,
    'POST',
    `/v1/admin/departments/${encodeURIComponent(id)}/retire`,
    AdminDepartmentDetailSchema,
    {
      expectedVersion: body.expectedVersion,
      ...(body.moveMembersTo !== undefined ? { moveMembersTo: body.moveMembersTo } : {}),
    },
  );
}

/** `POST /v1/admin/departments/:id/restore`. */
export function restoreDepartment(
  session: Session,
  id: string,
  body: RestoreDepartmentBody,
): Promise<AdminDepartmentDetail> {
  return requestParsed(
    session,
    'POST',
    `/v1/admin/departments/${encodeURIComponent(id)}/restore`,
    AdminDepartmentDetailSchema,
    { expectedVersion: body.expectedVersion },
  );
}

export interface DepartmentPeopleSaveInput {
  changes: DepartmentChange[];
  expectedRevision: string;
  note?: string | undefined;
  /** True when the person ticked every confirm warning in the review dialog. */
  acknowledged?: boolean | undefined;
}

/**
 * `POST /v1/admin/departments/:id/people`: head, add, remove, move, level and job title changes,
 * saved together against the access revision (spec 5.2 path b).
 */
export function saveDepartmentPeople(
  session: Session,
  id: string,
  input: DepartmentPeopleSaveInput,
): Promise<UpdateDepartmentPeopleResponse> {
  const note = input.note?.trim();
  return requestParsed(
    session,
    'POST',
    `/v1/admin/departments/${encodeURIComponent(id)}/people`,
    UpdateDepartmentPeopleResponseSchema,
    {
      changes: input.changes,
      expectedRevision: input.expectedRevision,
      ...(note ? { note } : {}),
      ...(input.acknowledged !== undefined ? { acknowledged: input.acknowledged } : {}),
    },
  );
}

export interface DepartmentStaffOption {
  id: string;
  name: string;
  email: string | null;
  roles: RoleKey[];
  department: { id: string; name: string } | null;
}

/**
 * Active people for the Head picker and "Add people". Empty when the viewer may not list users
 * (403): the screens then offer only the department's current members.
 */
export async function listActiveStaff(session: Session): Promise<DepartmentStaffOption[]> {
  const items: DepartmentStaffOption[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  try {
    do {
      const params = new URLSearchParams({ limit: '200' });
      params.append('status', 'active');
      if (after) params.set('after', after);
      const page = await requestParsed(
        session,
        'GET',
        `/v1/admin/users?${params.toString()}`,
        AdminUsersPageSchema,
      );
      for (const user of page.items) {
        if (user.status !== 'active') continue;
        items.push({
          id: user.id,
          name: user.displayName?.trim() || user.email?.trim() || 'Unnamed person',
          email: user.email,
          roles: user.roles,
          department: user.department
            ? { id: user.department.id, name: user.department.name }
            : null,
        });
      }
      after = page.nextAfter;
      if (after && seen.has(after)) break;
      if (after) seen.add(after);
    } while (after);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return [];
    throw error;
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

// ---------------------------------------------------------------------------------------------
// Error mapping (the ErrorBodyFilter envelope `{ error: { code, message, details, fieldErrors } }`)
// ---------------------------------------------------------------------------------------------

export type DepartmentWriteFailure =
  | { kind: 'stale'; message: string }
  | { kind: 'invalid'; message: string; fieldErrors?: Record<string, string> }
  | { kind: 'notFound'; message: string }
  | { kind: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapErrorBody(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error)) return body.error;
  return body;
}

/** String entries only: `details` may also carry numbers such as `activeMembers`. */
function stringEntries(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim() !== '') out[key] = entry;
  }
  return out;
}

/**
 * Turns a failed department write into a typed result. A 409 is stale whatever its code
 * (`conflict` for the department's version, `stale_access` for the access revision); a 400/422
 * carries its field messages in `details` or `fieldErrors`.
 */
export function mapDepartmentWriteError(error: unknown): DepartmentWriteFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'error', message: DEPARTMENT_SAVE_ERROR_MESSAGE };
  }
  const payload = unwrapErrorBody(error.body);
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  const serverMessage =
    typeof payload?.message === 'string' && payload.message.trim() !== ''
      ? payload.message
      : undefined;

  switch (error.status) {
    case 409:
      return {
        kind: 'stale',
        message:
          code === 'stale_access' ? DEPARTMENT_ACCESS_STALE_MESSAGE : DEPARTMENT_STALE_MESSAGE,
      };
    case 400:
    case 422: {
      const fieldErrors = {
        ...stringEntries(payload?.details),
        ...stringEntries(payload?.fieldErrors),
      };
      return {
        kind: 'invalid',
        message: serverMessage ?? 'Check the highlighted fields.',
        ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
      };
    }
    case 404:
      return { kind: 'notFound', message: 'This department could not be found.' };
    case 403:
      return { kind: 'error', message: DEPARTMENT_FORBIDDEN_MESSAGE };
    case 401:
      return { kind: 'error', message: 'Your session has expired. Sign in again to continue.' };
    default:
      return { kind: 'error', message: DEPARTMENT_SAVE_ERROR_MESSAGE };
  }
}
