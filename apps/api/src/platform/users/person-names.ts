// Display names of the people a record refers to (its owner, requester, deciders, history actors), returned
// with that record so a reader needs no admin directory to label them. The caller has already been allowed to
// read the record; this reads only the users it names, in the record's tenant. Inactive users keep their name:
// history must still say who acted. A user without a display name is shown by the part of their address before
// the @ (never the full address); one with neither is left out, and the page says the name is unavailable.
import type { PersonName } from '@bos/contracts';
import { users } from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db, DbTransaction } from '../db/db.module';

export function personLabel(displayName: string | null, email: string | null): string | undefined {
  return displayName?.trim() || email?.split('@')[0]?.trim() || undefined;
}

export async function personNames(
  q: Db | DbTransaction,
  tenantId: string,
  ids: Iterable<string | null | undefined>,
): Promise<PersonName[]> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return [];
  const rows = await q
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted)));
  return rows.flatMap((r) => {
    const name = personLabel(r.displayName, r.email);
    return name ? [{ userId: r.id, name }] : [];
  });
}

/**
 * The same names by user id, for services that join a name onto every row of a list or detail (D46: `ownerName`,
 * `assigneeName`, `createdByName`). A person with no usable name is absent; callers map that to `null`.
 */
export async function personNameMap(
  q: Db | DbTransaction,
  tenantId: string,
  ids: Iterable<string | null | undefined>,
): Promise<ReadonlyMap<string, string>> {
  const people = await personNames(q, tenantId, ids);
  return new Map(people.map((p) => [p.userId, p.name]));
}

/**
 * The name to put on a record for `id`: null when the record names no one; "Unnamed user" when it names a user who
 * has neither a display name nor an address, so a screen never needs a placeholder of its own.
 */
export function nameIn(
  names: ReadonlyMap<string, string>,
  id: string | null | undefined,
): string | null {
  if (id === null || id === undefined) return null;
  return names.get(id) ?? 'Unnamed user';
}
