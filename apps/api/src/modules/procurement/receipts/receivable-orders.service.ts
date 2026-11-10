// ReceivableOrdersService: the picker behind "which purchase order am I receiving against?" (P4 unit P2d-2).
// Serves the NFRs:
// - "one legal entity at a time": only the acting entity's POs are read (scoped()), another entity's are never seen;
// - "amounts are exact": quantities are numeric(18,4) strings summed in Postgres and subtracted with decimal.js;
// - "money moves only after the right people agree": the route needs procurement.receipt.confirm (the warehouse),
//   the same grant that confirms the receipt, so the list shows nothing a caller could not then receive.
// A PO is receivable in the statuses ReceiptsService takes receipts in (RECEIVING_PO_STATUSES). Its open quantity is
// ordered - cancelled - received over every line, where received counts confirmed and reversed receipts (a reversal
// nets its original to zero) and never drafts: the same `confirmed` figure ReceiptsService.progress reports.
import {
  purchaseOrderLines,
  purchaseOrders,
  receiptLines,
  receipts,
  scoped,
  vendors,
} from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { RECEIVING_PO_STATUSES } from './receipt.rules';
import { ReceiptsCaller } from './receipts.caller';

/** Query of `GET /v1/procurement/receivable-orders`: newest issued first, at most `limit` rows. */
export const ListReceivableOrdersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReceivableOrdersQuery = z.infer<typeof ListReceivableOrdersQuerySchema>;

export interface ReceivableOrderDto {
  id: string;
  number: string;
  vendorId: string;
  /** `vendors.legalName`. */
  vendorName: string;
  /** `goods` or `service` when every line is of that kind, `mixed` otherwise. */
  kind: 'goods' | 'service' | 'mixed';
  status: 'issued' | 'partially_received';
  /** ISO timestamp. */
  issuedAt?: string;
  /** Decimal string with four places: ordered - cancelled - received, over all lines. */
  openQuantity: string;
}

const kindOf = (goodsLines: number, serviceLines: number): ReceivableOrderDto['kind'] =>
  goodsLines > 0 && serviceLines > 0 ? 'mixed' : goodsLines > 0 ? 'goods' : 'service';

@Injectable()
export class ReceivableOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: ReceiptsCaller,
  ) {}

  /**
   * The acting entity's POs that still take receipts, newest issued first. Two grouped reads however many POs there
   * are: the POs with their line sums, then the confirmed quantities of just those POs.
   */
  async list(query: ListReceivableOrdersQuery): Promise<ReceivableOrderDto[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const orders = await tx
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          vendorId: purchaseOrders.vendorId,
          vendorName: vendors.legalName,
          status: purchaseOrders.status,
          issuedAt: purchaseOrders.issuedAt,
          planned: sql<string>`sum(${purchaseOrderLines.orderedQuantity} - ${purchaseOrderLines.cancelledQuantity})`,
          goodsLines: sql<number>`count(*) filter (where ${purchaseOrderLines.kind} = 'goods')::int`,
          serviceLines: sql<number>`count(*) filter (where ${purchaseOrderLines.kind} = 'service')::int`,
        })
        .from(purchaseOrders)
        .innerJoin(
          purchaseOrderLines,
          and(
            eq(purchaseOrderLines.tenantId, purchaseOrders.tenantId),
            eq(purchaseOrderLines.organizationId, purchaseOrders.organizationId),
            eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
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
            inArray(purchaseOrders.status, [...RECEIVING_PO_STATUSES]),
          ),
        )
        .groupBy(
          purchaseOrders.id,
          purchaseOrders.number,
          purchaseOrders.vendorId,
          vendors.legalName,
          purchaseOrders.status,
          purchaseOrders.issuedAt,
        )
        .orderBy(desc(purchaseOrders.issuedAt), desc(purchaseOrders.id))
        .limit(query.limit);
      if (orders.length === 0) return [];

      const received = await tx
        .select({
          purchaseOrderId: receiptLines.purchaseOrderId,
          quantity: sql<string>`sum(${receiptLines.quantity})`,
        })
        .from(receiptLines)
        .innerJoin(
          receipts,
          and(
            eq(receipts.tenantId, receiptLines.tenantId),
            eq(receipts.id, receiptLines.receiptId),
          ),
        )
        .where(
          scoped(scope).where(
            receiptLines,
            and(
              inArray(
                receiptLines.purchaseOrderId,
                orders.map((o) => o.id),
              ),
              inArray(receipts.status, ['confirmed', 'reversed']),
            ),
          ),
        )
        .groupBy(receiptLines.purchaseOrderId);
      const receivedBy = new Map(received.map((r) => [r.purchaseOrderId, r.quantity]));

      return orders.map((o) => ({
        id: o.id,
        number: o.number,
        vendorId: o.vendorId,
        vendorName: o.vendorName,
        kind: kindOf(o.goodsLines, o.serviceLines),
        // The where clause keeps only the two receiving statuses.
        status: o.status as ReceivableOrderDto['status'],
        ...(o.issuedAt === null ? {} : { issuedAt: o.issuedAt.toISOString() }),
        openQuantity: new Decimal(o.planned).minus(receivedBy.get(o.id) ?? 0).toFixed(4),
      }));
    });
  }
}
