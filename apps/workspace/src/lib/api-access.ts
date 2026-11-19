import 'server-only';

// Typed, server-only calls to the Access Settings API (/v1/admin/access/*) plus read-only lookups
// needed by the Access screens (active departments for hand-over pickers, staff directory for
// Check a person). Every response is validated with Zod so a drifting API shape fails as 502.

import {
  type AccessCatalogueResponse,
  AccessCatalogueResponseSchema,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  AccessPreviewResponseSchema,
  type AccessSaveRequest,
  type AccessSaveResponse,
  AccessSaveResponseSchema,
  type AccessWarning,
  AccessWarningSchema,
  type AdminDepartmentList,
  AdminDepartmentListSchema,
  AdminUsersPageSchema,
  type CheckPersonReport,
  CheckPersonReportSchema,
  type RoleKey,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

export const ACCESS_LOAD_ERROR_MESSAGE =
  'Access settings could not load. Try again in a moment.';
export const ACCESS_STALE_ERROR_MESSAGE =
  'Access was changed by someone else. Reload to see the latest.';
export const ACCESS_SAVE_ERROR_MESSAGE =
  'Access changes could not be saved. Try again in a moment.';
export const ACCESS_PREVIEW_ERROR_MESSAGE =
  'Could not preview these changes. Try again in a moment.';

export interface AccessPersonOption {
  id: string;
  name: string;
  email: string | null;
  status: 'invited' | 'active' | 'inactive';
  roles: RoleKey[];
  departmentName: string | null;
}

export type AccessSaveFailure =
  | { kind: 'stale'; message: string }
  | { kind: 'confirmation'; message: string; warnings: AccessWarning[] }
  | {
      kind: 'invalid';
      message: string;
      warnings?: AccessWarning[];
      fieldErrors?: Record<string, string>;
    }
  | { kind: 'error'; message: string };

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
  method: 'GET' | 'POST',
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

/** `GET /v1/admin/access` — full access catalogue, grants, rules, summaries, and revision. */
export function getAccessCatalogue(session: Session): Promise<AccessCatalogueResponse> {
  return requestParsed(session, 'GET', '/v1/admin/access', AccessCatalogueResponseSchema);
}

/** `POST /v1/admin/access/preview` — dry-run changes and return applied rows, impact, and warnings. */
export function previewAccessChanges(
  session: Session,
  input: AccessPreviewRequest,
): Promise<AccessPreviewResponse> {
  const body: AccessPreviewRequest = {
    changes: input.changes,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.acknowledged !== undefined ? { acknowledged: input.acknowledged } : {}),
    ...(input.person !== undefined ? { person: input.person } : {}),
  };
  return requestParsed(
    session,
    'POST',
    '/v1/admin/access/preview',
    AccessPreviewResponseSchema,
    body,
  );
}

/** `POST /v1/admin/access` — save staged changes atomically against `expectedRevision`. */
export function saveAccessChanges(
  session: Session,
  input: AccessSaveRequest,
): Promise<AccessSaveResponse> {
  const body: AccessSaveRequest = {
    changes: input.changes,
    expectedRevision: input.expectedRevision,
    acknowledged: input.acknowledged,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return requestParsed(session, 'POST', '/v1/admin/access', AccessSaveResponseSchema, body);
}

/** `GET /v1/admin/access/check?person=<id>` — effective access report for one person. */
export function checkPersonAccess(
  session: Session,
  personId: string,
): Promise<CheckPersonReport> {
  const params = new URLSearchParams({ person: personId });
  return requestParsed(
    session,
    'GET',
    `/v1/admin/access/check?${params.toString()}`,
    CheckPersonReportSchema,
  );
}

/**
 * Active departments for assignment hand-over pickers. `GET /v1/admin/departments` allows callers
 * with `admin.roles.read` as well as `admin.users.read`.
 */
export function listActiveDepartmentsForAccess(session: Session): Promise<AdminDepartmentList> {
  return requestParsed(
    session,
    'GET',
    '/v1/admin/departments?status=active',
    AdminDepartmentListSchema,
  );
}

/**
 * Staff list for the Check a person picker and the in-dialog preview picker. Returns an empty list
 * when the viewer holds `admin.roles.read` without `admin.users.read` (403), so direct
 * `?person=<id>` links still work without breaking the page.
 */
export async function listAccessPeople(session: Session): Promise<AccessPersonOption[]> {
  const items: AccessPersonOption[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  try {
    do {
      const params = new URLSearchParams({ limit: '200' });
      if (after) params.set('after', after);
      const page = await requestParsed(
        session,
        'GET',
        `/v1/admin/users?${params.toString()}`,
        AdminUsersPageSchema,
      );
      for (const user of page.items) {
        items.push({
          id: user.id,
          name: user.displayName?.trim() || user.email?.trim() || 'Unnamed person',
          email: user.email,
          status: user.status,
          roles: user.roles,
          departmentName: user.department?.name ?? null,
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
// Error payload parsing (handles ErrorBodyFilter's `{ error: { ... } }` envelope and flat bodies)
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapErrorBody(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error)) return body.error;
  return body;
}

function parseWarnings(value: unknown): AccessWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = z.array(AccessWarningSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseFieldErrors(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Turns a failed `saveAccessChanges` error into a typed UI result covering 409 stale revision,
 * 409 unacknowledged warnings, 422 validation/blocked warnings, and 403/5xx failures.
 */
export function mapAccessSaveError(error: unknown): AccessSaveFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'error', message: ACCESS_SAVE_ERROR_MESSAGE };
  }
  const payload = unwrapErrorBody(error.body);
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  const serverMessage =
    typeof payload?.message === 'string' && payload.message.trim().length > 0
      ? payload.message
      : undefined;

  if (error.status === 409) {
    if (code === 'stale_access') {
      return { kind: 'stale', message: ACCESS_STALE_ERROR_MESSAGE };
    }
    if (code === 'confirmation_required') {
      return {
        kind: 'confirmation',
        message: serverMessage ?? 'Please confirm the warnings before saving.',
        warnings: parseWarnings(payload?.warnings) ?? [],
      };
    }
    return { kind: 'stale', message: serverMessage ?? ACCESS_STALE_ERROR_MESSAGE };
  }

  if (error.status === 422 || error.status === 400) {
    const warnings = parseWarnings(payload?.warnings);
    const fieldErrors = parseFieldErrors(payload?.fieldErrors);
    return {
      kind: 'invalid',
      message: serverMessage ?? 'Some changes could not be applied. Check the highlighted items.',
      ...(warnings !== undefined ? { warnings } : {}),
      ...(fieldErrors !== undefined ? { fieldErrors } : {}),
    };
  }

  if (error.status === 403) {
    return {
      kind: 'error',
      message: 'You do not have permission to change access settings.',
    };
  }

  return { kind: 'error', message: ACCESS_SAVE_ERROR_MESSAGE };
}

/** Turns a failed `previewAccessChanges` error into a plain-language message. */
export function mapAccessPreviewError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to preview access changes.';
    }
    const payload = unwrapErrorBody(error.body);
    if (
      (error.status === 400 || error.status === 422) &&
      typeof payload?.message === 'string' &&
      payload.message.trim().length > 0
    ) {
      return payload.message;
    }
  }
  return ACCESS_PREVIEW_ERROR_MESSAGE;
}
