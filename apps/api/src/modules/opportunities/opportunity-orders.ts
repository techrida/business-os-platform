// The deal's sales orders as dated history events (R6Q22), listed beside the stage history on the opportunity detail.
// An order reaches a deal through its quotation. Only the orders the reader may read themselves are returned: the same
// registered `sales_order.read` reach the order list uses (scopeWhereFor), so reading the deal never reads an order the
// reader could not open.
import type { OpportunityDto } from '@bos/contracts';
import { quotations, salesOrders, scoped } from '@bos/db';
import { and, asc, eq } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { DbTransaction, TxScope } from '../../platform/db/tx';
import { nameIn, personNameMap } from '../../platform/users/person-names';

type OrderHistory = NonNullable<OpportunityDto['orderHistory']>;

export async function orderHistoryOf(
  tx: DbTransaction,
  scope: TxScope,
  principal: Principal,
  opportunityId: string,
): Promise<OrderHistory> {
  const orders = await tx
    .select({
      id: salesOrders.id,
      number: salesOrders.number,
      createdAt: salesOrders.createdAt,
      createdBy: salesOrders.createdBy,
      confirmedAt: salesOrders.confirmedAt,
      confirmedBy: salesOrders.confirmedBy,
      cancelledAt: salesOrders.cancelledAt,
    })
    .from(salesOrders)
    .innerJoin(
      quotations,
      and(
        eq(quotations.tenantId, salesOrders.tenantId),
        eq(quotations.id, salesOrders.quotationId),
      ),
    )
    .where(
      and(
        scoped(scope).where(salesOrders, eq(quotations.opportunityId, opportunityId)),
        scopeWhereFor(principal, salesOrders, 'sales_order.read'),
      ),
    )
    .orderBy(asc(salesOrders.createdAt), asc(salesOrders.id));
  if (orders.length === 0) return [];

  const names = await personNameMap(
    tx,
    scope.tenantId,
    orders.flatMap((o) => [o.createdBy, o.confirmedBy]),
  );
  const who = (id: string | null) => (id === null ? null : nameIn(names, id));
  const events: OrderHistory = [];
  for (const o of orders) {
    const base = { salesOrderId: o.id, number: o.number };
    events.push({
      ...base,
      event: 'drafted',
      at: o.createdAt.toISOString(),
      actorName: who(o.createdBy),
    });
    if (o.confirmedAt !== null) {
      events.push({
        ...base,
        event: 'confirmed',
        at: o.confirmedAt.toISOString(),
        actorName: who(o.confirmedBy),
      });
    }
    if (o.cancelledAt !== null) {
      events.push({
        ...base,
        event: 'cancelled',
        at: o.cancelledAt.toISOString(),
        actorName: null,
      });
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
