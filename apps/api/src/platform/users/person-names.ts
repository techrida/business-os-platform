// Display names of the people a record refers to (its owner, requester, deciders, history actors), returned
// with that record so a reader needs no admin directory to label them. The caller has already been allowed to
// read the record; this reads only the users it names, in the record's tenant. Inactive users keep their name:
// history must still say who acted. A user without a display name is "Unnamed user" (D54-2): no part of their
// address stands in for a name, because the address is personal data a record reader was never granted.
import type { PersonName } from '@bos/contracts';
import { users } from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db, DbTransaction } from '../db/db.module';

/** The fallback for a person with no display name, and for an id that names no user of the tenant. */
export const UNNAMED_USER = 'Unnamed user';

/**
 * The label for one person. `_email` is accepted and ignored so a caller that still passes the address cannot
 * turn it back into a name.
 */
export function personLabel(displayName: string | null, _email?: string | null): string {
  return displayName?.trim() || UNNAMED_USER;
}

export async function personNames(
  q: Db | DbTransaction,
  tenantId: string,
  ids: Iterable<string | null | undefined>,
): Promise<PersonName[]> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return [];
  const rows = await q
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarDocumentId: users.avatarDocumentId,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted)));
  return rows.map((r) => ({
    userId: r.id,
    name: personLabel(r.displayName),
    avatarDocumentId: r.avatarDocumentId,
  }));
}

/**
 * The same names by user id, for services that join a name onto every row of a list or detail (D46: `ownerName`,
 * `assigneeName`, `createdByName`). An id that names no user of the tenant is absent; `nameIn` labels it.
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
 * The name to put on a record for `id`: null when the record names no one; "Unnamed user" when it names a user with
 * no display name or one the tenant does not have, so a screen never needs a placeholder of its own.
 */
export function nameIn(
  names: ReadonlyMap<string, string>,
  id: string | null | undefined,
): string | null {
  if (id === null || id === undefined) return null;
  return names.get(id) ?? UNNAMED_USER;
}
