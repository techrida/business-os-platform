// The document owner policy of a quotation version (owner type `quotation_version`, owner id = the version id).
// Serves the NFRs "an approved quotation is exactly what was approved" and "deny by default":
// - a user attaches or removes files only while the version is a draft, so no file appears on a version after the
//   approvers saw it (the same rule as a submitted memo);
// - the only background job allowed to add a generated file is the quotation render job, and only to an approved
//   version: that is the PDF of exactly the approved content. Any other job, and any non-system actor, is refused.
// The policy decides on the status alone and reads it through a loader, so unit tests need no database; the real
// loader (`drizzleHeadLoader`) is what QuotationsModule registers.
import { quotations, quotationVersions } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';

export const QUOTATION_OWNER_TYPE = 'quotation_version';

/** The job name (after the `system:` prefix of the actor id) that may add the rendered PDF. */
export const QUOTATION_RENDER_JOB_PREFIX = 'quotation-render';

type VersionStatus = typeof quotationVersions.$inferSelect.status;

/** What the policy needs of a version: its status and what authz decides on. */
export interface QuotationOwnerHead {
  status: VersionStatus;
  tenantId: string;
  organizationId: string;
  /** The owner of the quotation (the `own` scope of the quotation permissions). */
  ownerUserId: string | null;
  customerPartyId: string | null;
}

/** With `lock`, the version row is locked FOR SHARE in `tx`, so an attach cannot interleave with a submit. */
export type QuotationHeadLoader = (
  scope: TxScope,
  versionId: string,
  lock?: { tx: DbTransaction; lock: 'share' },
) => Promise<QuotationOwnerHead | undefined>;

export class QuotationOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = QUOTATION_OWNER_TYPE;

  constructor(private readonly load: QuotationHeadLoader) {}

  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const head = await this.load(scope, ownerId, undefined);
    if (head === undefined) return null;
    return {
      tenantId: head.tenantId,
      organizationId: head.organizationId,
      ownerUserId: head.ownerUserId,
      customerPartyId: head.customerPartyId,
      sodUserIds: [],
    };
  }

  /** A user may attach to, and remove from, a draft only. */
  async canAttach(scope: TxScope, ownerId: string, tx?: DbTransaction): Promise<boolean> {
    const head = await this.load(
      scope,
      ownerId,
      tx === undefined ? undefined : { tx, lock: 'share' },
    );
    return head !== undefined && head.status === 'draft';
  }

  /** The render job, and only on an approved version. Every other system actor is refused. */
  async allowsSystemActor(
    scope: TxScope,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx?: DbTransaction,
  ): Promise<boolean> {
    // Decide on who is asking before touching the database: a refused actor costs no query.
    if (actor.kind !== 'system' || !actor.id.startsWith(`system:${QUOTATION_RENDER_JOB_PREFIX}`)) {
      return false;
    }
    const head = await this.load(
      scope,
      ownerId,
      tx === undefined ? undefined : { tx, lock: 'share' },
    );
    return head !== undefined && head.status === 'approved';
  }
}

/** The loader on the real tables: the version in this tenant and acting entity, with its quotation's owner. */
export function drizzleHeadLoader(db: Db): QuotationHeadLoader {
  return async (scope, versionId, lock) => {
    const key = and(
      eq(quotationVersions.tenantId, scope.tenantId),
      eq(quotationVersions.organizationId, scope.organizationId),
      eq(quotationVersions.id, versionId),
    );
    // Lock the version row on its own: drizzle writes `FOR SHARE OF "app"."quotation_versions"` when a joined
    // select is locked, and Postgres rejects the schema-qualified name. The read below sees the row as locked.
    if (lock !== undefined) {
      const [locked] = await lock.tx
        .select({ id: quotationVersions.id })
        .from(quotationVersions)
        .where(key)
        .for(lock.lock);
      if (locked === undefined) return undefined;
    }
    const [found] = await (lock?.tx ?? db)
      .select({
        status: quotationVersions.status,
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        ownerUserId: quotations.ownerUserId,
        customerPartyId: quotations.customerPartyId,
      })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .where(key)
      .limit(1);
    return found;
  };
}
