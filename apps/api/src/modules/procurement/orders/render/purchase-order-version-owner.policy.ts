// The document owner policy of a purchase order version (owner type `purchase_order_version`, owner id = the version
// id). Serves the NFRs "an issued purchase order is exactly what was issued" and "deny by default":
// - no person attaches files to a version or removes them: the legal document is the generated PDF alone;
// - the only background job allowed to add a generated file is the PO render job, and only to a version that exists
//   in the acting entity (a version is written only when a PO is issued or amended, and never changes);
//   any other job, and any non-system actor, is refused;
// - `resource` names the vendor party, so a later vendor portal read can be decided on it.
// The policy reads the version through a loader, so unit tests need no database. The loader takes no row lock: a
// version is immutable (bos_app holds no UPDATE on the table, which FOR SHARE would need), so there is no race to close.
import { purchaseOrders, purchaseOrderVersions } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { ResourceRef } from '../../../../platform/authz/can';
import type { Db, DbTransaction } from '../../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../../../platform/documents/documents.ports';

export const PO_VERSION_OWNER_TYPE = 'purchase_order_version';

/** The job name (after the `system:` prefix of the actor id) that may add the rendered PDF. */
export const PO_RENDER_JOB_PREFIX = 'purchase-order-render';

/** What the policy needs of a version: where it lives and which vendor it names. */
export interface PoVersionOwnerHead {
  tenantId: string;
  organizationId: string;
  vendorId: string;
}

export type PoVersionHeadLoader = (
  scope: TxScope,
  versionId: string,
  tx?: DbTransaction,
) => Promise<PoVersionOwnerHead | undefined>;

export class PurchaseOrderVersionOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = PO_VERSION_OWNER_TYPE;

  constructor(private readonly load: PoVersionHeadLoader) {}

  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const head = await this.load(scope, ownerId);
    if (head === undefined) return null;
    return {
      tenantId: head.tenantId,
      organizationId: head.organizationId,
      ownerUserId: null,
      vendorPartyId: head.vendorId,
      sodUserIds: [],
    };
  }

  /** Nobody attaches to, or removes from, an issued version by hand. */
  canAttach(_scope: TxScope, _ownerId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** The render job, and only on a version of the acting entity. Every other system actor is refused. */
  async allowsSystemActor(
    scope: TxScope,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx?: DbTransaction,
  ): Promise<boolean> {
    // Decide on who is asking before touching the database: a refused actor costs no query.
    if (actor.kind !== 'system' || actor.id !== `system:${PO_RENDER_JOB_PREFIX}`) return false;
    return (await this.load(scope, ownerId, tx)) !== undefined;
  }
}

/** The loader on the real tables: the version in this tenant and acting entity, with its PO's vendor. */
export function drizzlePoVersionHeadLoader(db: Db): PoVersionHeadLoader {
  return async (scope, versionId, tx) => {
    const [found] = await (tx ?? db)
      .select({
        tenantId: purchaseOrderVersions.tenantId,
        organizationId: purchaseOrderVersions.organizationId,
        vendorId: purchaseOrders.vendorId,
      })
      .from(purchaseOrderVersions)
      .innerJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, purchaseOrderVersions.tenantId),
          eq(purchaseOrders.organizationId, purchaseOrderVersions.organizationId),
          eq(purchaseOrders.id, purchaseOrderVersions.purchaseOrderId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderVersions.tenantId, scope.tenantId),
          eq(purchaseOrderVersions.organizationId, scope.organizationId),
          eq(purchaseOrderVersions.id, versionId),
        ),
      )
      .limit(1);
    return found;
  };
}
