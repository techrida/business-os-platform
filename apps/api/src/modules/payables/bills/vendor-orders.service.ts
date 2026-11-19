// VendorOrdersService: the purchase order pickers of the payables screens (U18 #12 and #13). The bill entry form and
// the payment request form name a PO; without a picker the person had to paste a raw id, and the accountant and
// Finance hold no purchase order read. Each picker sits under the grant of the form it serves (payables.bill.enter,
// payables.payment.request), never procurement's, and returns only what the picker shows: id, number, status and
// the vendor it belongs to. Scoped in SQL to the acting entity (scoped()) and, when asked, to one vendor.
import type { PoStatus } from '@bos/contracts';
import { purchaseOrders, scoped } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { BILLABLE_PO_STATUSES } from './vendor-bill.rules';
import { VendorBillsCaller } from './vendor-bills.caller';

/** Query of both pickers: one vendor's orders (optional), newest issued first, at most `limit`. */
export const ListVendorOrdersQuerySchema = z.strictObject({
  vendorId: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListVendorOrdersQuery = z.infer<typeof ListVendorOrdersQuerySchema>;

/**
 * The PO statuses a payment request may name: any order that was issued and not cancelled. The payment request
 * service accepts any PO of the vendor; a draft or cancelled one is never something to pay against, so the picker
 * leaves those out.
 */
export const PAYMENT_REQUEST_PO_STATUSES = [
  'issued',
  'partially_received',
  'fully_received',
  'amendment_pending',
  'closed',
  'short_closed',
] as const satisfies readonly PoStatus[];

export interface VendorOrderOptionDto {
  id: string;
  number: string;
  status: PoStatus;
  vendorId: string;
}

@Injectable()
export class VendorOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: VendorBillsCaller,
  ) {}

  /** The entity's POs a bill can be entered against (BILLABLE_PO_STATUSES, the statuses create() accepts). */
  billable(query: ListVendorOrdersQuery): Promise<VendorOrderOptionDto[]> {
    return this.options(query, BILLABLE_PO_STATUSES);
  }

  /** The entity's POs a payment request can name. */
  forPaymentRequest(query: ListVendorOrdersQuery): Promise<VendorOrderOptionDto[]> {
    return this.options(query, PAYMENT_REQUEST_PO_STATUSES);
  }

  private options(
    query: ListVendorOrdersQuery,
    statuses: readonly PoStatus[],
  ): Promise<VendorOrderOptionDto[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, (tx) =>
      tx
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          status: purchaseOrders.status,
          vendorId: purchaseOrders.vendorId,
        })
        .from(purchaseOrders)
        .where(
          scoped(scope).where(
            purchaseOrders,
            and(
              inArray(purchaseOrders.status, [...statuses]),
              query.vendorId === undefined
                ? undefined
                : eq(purchaseOrders.vendorId, query.vendorId),
            ),
          ),
        )
        .orderBy(desc(purchaseOrders.issuedAt), desc(purchaseOrders.number))
        .limit(query.limit),
    );
  }
}
