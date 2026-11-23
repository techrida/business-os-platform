// The muted "role" a member picker shows after a person's name (BOS-UI-001): their job title and department in the
// acting entity, the same two facts the memo people list carries. One helper so every people endpoint words it the
// same way. Nothing here is sensitive: both are shown on a memo to anyone who may write one.
import { departments, userEntities } from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction } from '../db/tx';

/** "Sales Executive · Sales", "Sales" or "Sales Executive"; null when the person has neither. */
export function roleLine(jobTitle: string | null, departmentName: string | null): string | null {
  const line = [jobTitle, departmentName]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' · ');
  return line === '' ? null : line;
}

/** The department names of an entity, by id, for the role lines of its members. */
export async function departmentNames(
  tx: DbTransaction,
  scope: { tenantId: string; organizationId: string },
  ids: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(
      and(
        eq(departments.tenantId, scope.tenantId),
        eq(departments.organizationId, scope.organizationId),
        inArray(departments.id, wanted),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The role line of each named user in the acting entity (a user with no membership there is absent). */
export async function roleLines(
  tx: DbTransaction,
  scope: { tenantId: string; organizationId: string },
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({
      userId: userEntities.userId,
      jobTitle: userEntities.jobTitle,
      departmentId: userEntities.departmentId,
    })
    .from(userEntities)
    .where(
      and(
        eq(userEntities.tenantId, scope.tenantId),
        eq(userEntities.organizationId, scope.organizationId),
        inArray(userEntities.userId, [...userIds]),
      ),
    );
  const names = await departmentNames(
    tx,
    scope,
    rows.map((r) => r.departmentId),
  );
  return new Map(
    rows.map((r) => [
      r.userId,
      roleLine(r.jobTitle, r.departmentId === null ? null : (names.get(r.departmentId) ?? null)),
    ]),
  );
}
