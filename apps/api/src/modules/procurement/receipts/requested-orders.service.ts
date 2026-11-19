// RequestedOrdersService: the purchase orders raised from the caller's own purchase requests (U18 #4). A requester
// may confirm a service receipt on such an order (ReceiptsService.assertMayReceive) and read its receipts under
// `procurement.pr.read` own scope, but holds no purchase order read, so the receipts page had them paste a raw id.
// This list is the picker instead. It is always the caller's own: the join keeps only orders whose request the
// caller raised, and of those only the requests the caller may still read (`procurement.pr.read`, the predicate the
// request's own detail uses, so a requester who moved out of a department-scoped read loses its old orders too),
// and only the acting entity's (scoped()). Each row carries what the picker shows and nothing else: id, number,
// status and the vendor's legal name.
import type { PoStatus } from '@bos/contracts';
import { purchaseOrders, purchaseRequests, scoped, vendors } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';

import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { purchaseRequestScopeWhere } from '../requests/purchase-requests.service';
import { ReceiptsCaller } from './receipts.caller';

/** Query of `GET /v1/procurement/requested-orders`: newest issued first, at most `limit` rows. */
export const ListRequestedOrdersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListRequestedOrdersQuery = z.infer<typeof ListRequestedOrdersQuerySchema>;

export interface RequestedOrderDto {
  id: string;
  number: string;
  status: PoStatus;
  /** `vendors.legalName`. */
  vendorName: string;
}

/** A draft was never sent to the vendor and a cancelled order has nothing to receive: neither is listed. */
const HIDDEN_STATUSES: readonly PoStatus[] = ['draft', 'cancelled'];

@Injectable()
export class RequestedOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: ReceiptsCaller,
  ) {}

  list(query: ListRequestedOrdersQuery): Promise<RequestedOrderDto[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, (tx) =>
      tx
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          status: purchaseOrders.status,
          vendorName: vendors.legalName,
        })
        .from(purchaseOrders)
        .innerJoin(
          purchaseRequests,
          and(
            eq(purchaseRequests.tenantId, purchaseOrders.tenantId),
            eq(purchaseRequests.organizationId, purchaseOrders.organizationId),
            eq(purchaseRequests.id, purchaseOrders.purchaseRequestId),
          ),
        )
        .innerJoin(
          vendors,
          and(
            eq(vendors.tenantId, purchaseOrders.tenantId),
            eq(vendors.id, purchaseOrders.vendorId),
          ),
        )
        .where(
          scoped(scope).where(
            purchaseOrders,
            and(
              eq(purchaseRequests.requesterUserId, principal.userId),
              purchaseRequestScopeWhere(principal, 'procurement.pr.read'),
              notInArray(purchaseOrders.status, [...HIDDEN_STATUSES]),
            ),
          ),
        )
        .orderBy(desc(purchaseOrders.issuedAt), desc(purchaseOrders.number))
        .limit(query.limit),
    );
  }
}
