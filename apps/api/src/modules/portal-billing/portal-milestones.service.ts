// The customer portal's milestones (F1-Q34, Kuu 2026-11-20; D15): a milestone is an instalment of the billing
// schedule of one of the customer's sales orders. Read only. Serves the NFR "a customer sees only what we meant to
// show", the same way the invoice reads do:
// - only a customer principal with a party gets in (assertCustomerCaller, 403 before any query);
// - every order query is `forCounterparty(salesOrders, 'customer', partyId)` in the acting entity, and only when that
//   entity is the tenant's default one;
// - only confirmed and completed orders: a draft or cancelled order, another customer's order and an unknown id all
//   answer the same 404;
// - the view is built field by field and parsed with the strict contract schema. A cancelled line is left out; a
//   drafted line reads as `reached` (its invoice is not issued, so it is not shown); a line names its invoice only
//   when that invoice passes the portal invoice filter (issued, a portal kind, the caller's, the default entity).
import {
  PortalSalesOrderSchema,
  type PortalMilestone,
  type PortalMilestoneStatus,
  type PortalSalesOrder,
  trimPercent,
} from '@bos/contracts';
import { billingScheduleLines, invoices, organizations, salesOrders, scoped } from '@bos/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import { assertCustomerCaller, PortalCaller } from '../portal/portal.caller';
import { visibleTo as invoiceVisibleTo } from './portal-billing.service';

/** The order statuses a customer sees. */
export const PORTAL_ORDER_STATUSES = ['confirmed', 'completed'] as const;

/** One fixed refusal for every hidden id: the bodies are byte-identical. */
const notFound = () => new NotFoundException('Sales order not found');

type OrderRow = Pick<
  typeof salesOrders.$inferSelect,
  'id' | 'number' | 'status' | 'confirmedAt' | 'currency' | 'total'
>;
type LineRow = Pick<
  typeof billingScheduleLines.$inferSelect,
  'salesOrderId' | 'seq' | 'label' | 'percent' | 'amount' | 'plannedDate' | 'status' | 'invoiceId'
>;
type InvoiceRef = NonNullable<PortalMilestone['invoice']>;

/** The customer's word for a schedule line's status. Cancelled lines never reach this (the query drops them). */
export function toPortalMilestoneStatus(status: LineRow['status']): PortalMilestoneStatus {
  switch (status) {
    case 'invoiced':
      return 'invoiced';
    case 'billable':
    case 'drafted':
      return 'reached';
    default:
      return 'upcoming';
  }
}

/** The strict customer view of one order, field by field. `visibleInvoices` holds only invoices the portal shows. */
export function toPortalSalesOrder(
  order: OrderRow,
  lines: readonly LineRow[],
  visibleInvoices: ReadonlyMap<string, InvoiceRef>,
): PortalSalesOrder {
  return PortalSalesOrderSchema.parse({
    id: order.id,
    number: order.number,
    status: order.status,
    confirmedAt: order.confirmedAt === null ? null : order.confirmedAt.toISOString(),
    currency: order.currency,
    total: order.total,
    milestones: lines
      .filter((l) => l.salesOrderId === order.id && l.status !== 'cancelled')
      .sort((a, b) => a.seq - b.seq)
      .map((l) => {
        const status = toPortalMilestoneStatus(l.status);
        const invoice =
          status === 'invoiced' && l.invoiceId !== null
            ? (visibleInvoices.get(l.invoiceId) ?? null)
            : null;
        return {
          seq: l.seq,
          label: l.label,
          percent: l.percent === null ? null : trimPercent(l.percent),
          amount: l.amount,
          plannedDate: l.plannedDate,
          status,
          invoice,
        };
      }),
  });
}

@Injectable()
export class PortalMilestonesService {
  constructor(
    private readonly caller: PortalCaller,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** The caller's confirmed and completed orders with their milestones, newest confirmation first. */
  async list(): Promise<PortalSalesOrder[]> {
    const p = this.customer();
    const orders = await this.orders(p);
    return this.withMilestones(p, orders);
  }

  /** One of the caller's orders with its milestones. 404 unless it is the caller's, visible, and confirmed or done. */
  async get(id: string): Promise<PortalSalesOrder> {
    const p = this.customer();
    const [order] = await this.orders(p, eq(salesOrders.id, id));
    if (order === undefined) throw notFound();
    const [view] = await this.withMilestones(p, [order]);
    if (view === undefined) throw notFound();
    return view;
  }

  // ------------------------------------------------------------------------------------------- internals

  private customer(): Principal {
    const p = this.caller.current();
    assertCustomerCaller(p);
    return p;
  }

  private orders(p: Principal, extra?: SQL): Promise<OrderRow[]> {
    return this.db
      .select({
        id: salesOrders.id,
        number: salesOrders.number,
        status: salesOrders.status,
        confirmedAt: salesOrders.confirmedAt,
        currency: salesOrders.currency,
        total: salesOrders.total,
      })
      .from(salesOrders)
      .where(orderVisibleTo(p, extra))
      .orderBy(desc(salesOrders.confirmedAt), desc(salesOrders.number));
  }

  private async withMilestones(
    p: Principal,
    orders: readonly OrderRow[],
  ): Promise<PortalSalesOrder[]> {
    if (orders.length === 0) return [];
    const s = scoped({ tenantId: p.tenantId, organizationId: p.organizationId });
    const lines = await this.db
      .select({
        salesOrderId: billingScheduleLines.salesOrderId,
        seq: billingScheduleLines.seq,
        label: billingScheduleLines.label,
        percent: billingScheduleLines.percent,
        amount: billingScheduleLines.amount,
        plannedDate: billingScheduleLines.plannedDate,
        status: billingScheduleLines.status,
        invoiceId: billingScheduleLines.invoiceId,
      })
      .from(billingScheduleLines)
      .where(
        s.where(
          billingScheduleLines,
          and(
            inArray(
              billingScheduleLines.salesOrderId,
              orders.map((o) => o.id),
            ),
            ne(billingScheduleLines.status, 'cancelled'),
          ),
        ),
      )
      .orderBy(asc(billingScheduleLines.seq));
    const invoiceIds = [
      ...new Set(
        lines.flatMap((l) =>
          l.status === 'invoiced' && l.invoiceId !== null ? [l.invoiceId] : [],
        ),
      ),
    ];
    const visible = new Map<string, InvoiceRef>();
    if (invoiceIds.length > 0) {
      const rows = await this.db
        .select({ id: invoices.id, number: invoices.number, dueDate: invoices.dueDate })
        .from(invoices)
        .where(invoiceVisibleTo(p, inArray(invoices.id, invoiceIds)));
      for (const r of rows) {
        if (r.number !== null)
          visible.set(r.id, { id: r.id, number: r.number, dueDate: r.dueDate });
      }
    }
    return orders.map((o) => toPortalSalesOrder(o, lines, visible));
  }
}

/**
 * The order filter: the caller's party in the acting entity (forCounterparty, ADR 0027 §5), only when that entity is
 * the tenant's default, and only a confirmed or completed order with a number. `extra` narrows further.
 */
function orderVisibleTo(p: Principal, extra?: SQL): SQL {
  // assertCustomerCaller ran first, so partyId is a non-empty string here.
  const partyId = p.partyId ?? '';
  const defaultEntity = sql`EXISTS (SELECT 1 FROM ${organizations}
      WHERE ${organizations.tenantId} = ${salesOrders.tenantId}
        AND ${organizations.id} = ${salesOrders.organizationId}
        AND ${organizations.isDefault})`;
  return scoped({ tenantId: p.tenantId, organizationId: p.organizationId }).forCounterparty(
    salesOrders,
    'customer',
    partyId,
    and(
      inArray(salesOrders.status, [...PORTAL_ORDER_STATUSES]),
      sql`${salesOrders.number} IS NOT NULL`,
      defaultEntity,
      ...(extra === undefined ? [] : [extra]),
    ),
  );
}
