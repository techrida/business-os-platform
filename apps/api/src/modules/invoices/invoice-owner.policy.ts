// The document owner policy of an invoice (owner type `invoice`, owner id = the invoice id). Serves the NFRs "an issued
// invoice is exactly what was issued" and "deny by default":
// - no person attaches files to an invoice or removes them: the legal document is the generated PDF alone;
// - the only background job allowed to add a generated file is the invoice render job (U11), and only to an issued
//   invoice: that is the PDF of exactly the issued content. Any other job, and any non-system actor, is refused.
// The policy decides on the status alone and reads it through a loader, so unit tests need no database; the real
// loader (`drizzleInvoiceHeadLoader`) is what InvoicesModule registers.
import { invoices } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';

export const INVOICE_OWNER_TYPE = 'invoice';

/** The job name (after the `system:` prefix of the actor id) that may add the rendered PDF. */
export const INVOICE_RENDER_JOB_PREFIX = 'invoice-render';

type InvoiceStatus = typeof invoices.$inferSelect.status;

/** What the policy needs of an invoice: its status and what authz decides on. */
export interface InvoiceOwnerHead {
  status: InvoiceStatus;
  tenantId: string;
  organizationId: string;
  /** Who drafted it. */
  ownerUserId: string | null;
  customerPartyId: string | null;
}

/** With `lock`, the invoice row is locked FOR SHARE in `tx`, so a generated file cannot interleave with a status change. */
export type InvoiceHeadLoader = (
  scope: TxScope,
  invoiceId: string,
  lock?: { tx: DbTransaction; lock: 'share' },
) => Promise<InvoiceOwnerHead | undefined>;

export class InvoiceOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = INVOICE_OWNER_TYPE;

  constructor(private readonly load: InvoiceHeadLoader) {}

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

  /** Nobody attaches to, or removes from, an invoice by hand. */
  canAttach(_scope: TxScope, _ownerId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** The render job, and only on an issued invoice. Every other system actor is refused. */
  async allowsSystemActor(
    scope: TxScope,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx?: DbTransaction,
  ): Promise<boolean> {
    // Decide on who is asking before touching the database: a refused actor costs no query.
    if (actor.kind !== 'system' || !actor.id.startsWith(`system:${INVOICE_RENDER_JOB_PREFIX}`)) {
      return false;
    }
    const head = await this.load(
      scope,
      ownerId,
      tx === undefined ? undefined : { tx, lock: 'share' },
    );
    return head !== undefined && head.status === 'issued';
  }
}

/** The loader on the real table: the invoice in this tenant and acting entity. */
export function drizzleInvoiceHeadLoader(db: Db): InvoiceHeadLoader {
  return async (scope, invoiceId, lock) => {
    const key = and(
      eq(invoices.tenantId, scope.tenantId),
      eq(invoices.organizationId, scope.organizationId),
      eq(invoices.id, invoiceId),
    );
    const [found] = await (lock === undefined
      ? db
          .select({
            status: invoices.status,
            tenantId: invoices.tenantId,
            organizationId: invoices.organizationId,
            ownerUserId: invoices.createdBy,
            customerPartyId: invoices.customerPartyId,
          })
          .from(invoices)
          .where(key)
          .limit(1)
      : lock.tx
          .select({
            status: invoices.status,
            tenantId: invoices.tenantId,
            organizationId: invoices.organizationId,
            ownerUserId: invoices.createdBy,
            customerPartyId: invoices.customerPartyId,
          })
          .from(invoices)
          .where(key)
          .limit(1)
          .for(lock.lock));
    return found;
  };
}
