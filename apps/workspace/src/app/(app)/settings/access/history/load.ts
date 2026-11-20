import 'server-only';

import { AuditEventDtoSchema, type AuditEventDto } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { HISTORY_ACTIONS } from './describe';

/**
 * The audit rows an access change writes: Settings > Access saves (grants, role resets, level and
 * assignment rules, member levels) and department edits. `GET /v1/audit` filters one type per call.
 */
export const ACCESS_HISTORY_ENTITY_TYPES = [
  'role_permission',
  'access_level_rule',
  'access_assignment_rule',
  'user_entity',
  'departments',
] as const;

/** The newest changes shown; there is no paging yet. */
export const HISTORY_LIMIT = 50;

const AuditListSchema = z.object({ items: z.array(AuditEventDtoSchema) });

async function listByType(session: Session, entityType: string): Promise<AuditEventDto[]> {
  const query = new URLSearchParams({ entityType, limit: String(HISTORY_LIMIT) });
  const res = await apiFetch(session, `/v1/audit?${query.toString()}`, { method: 'GET' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, `GET /v1/audit failed with ${res.status}`, body);
  const parsed = AuditListSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(502, 'GET /v1/audit returned an unexpected shape');
  return parsed.data.items;
}

/** The API's own order: newest chain month first, then newest sequence number. */
function newestFirst(a: AuditEventDto, b: AuditEventDto): number {
  if (a.chainMonth !== b.chainMonth) return a.chainMonth < b.chainMonth ? 1 : -1;
  return b.seq - a.seq;
}

/**
 * The latest access changes, newest first. Rows of these types that are not an access change (the
 * `departments` table is also audited row by row) are dropped. Needs `audit.read`.
 */
export async function listAccessHistory(session: Session): Promise<AuditEventDto[]> {
  const lists = await Promise.all(
    ACCESS_HISTORY_ENTITY_TYPES.map((type) => listByType(session, type)),
  );
  return lists
    .flat()
    .filter((event) => HISTORY_ACTIONS.has(event.action))
    .sort(newestFirst)
    .slice(0, HISTORY_LIMIT);
}
