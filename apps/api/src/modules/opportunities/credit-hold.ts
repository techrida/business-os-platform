// A deal's credit hold (F1-Q20, F1-Q26; Kuu R4a Q1b, R5 FU4). The deal is held when what the customer owes the acting
// entity now (open receivables), plus what its confirmed sales orders have not invoiced yet, plus the value of the
// order the deal is about to become, is more than the limit that entity gave it (`party_accounts.credit_limit`,
// NPR): a customer at 90,000 of a 100,000 limit is held for a 20,000 order, and so is one with a confirmed 90,000
// order that no invoice covers yet. Derived from the ledger, the orders and the deal's accepted quotation on every
// read, never stored, so a payment or a new invoice changes it at once. The one rule for the opportunity's flag,
// the credit-hold page, the override and the sales order gate: they must agree, or a deal the gate holds could not
// be overridden.
import Decimal from 'decimal.js';
import { type SQL, sql } from 'drizzle-orm';

import type { DbTransaction, TxScope } from '../../platform/db/tx';

export interface CreditPosition {
  /** NPR, two decimals; null when the entity set no limit (then never held). */
  creditLimit: string | null;
  /** Open receivables: NPR, two decimals; may be negative when the customer is in credit. */
  exposure: string;
  /**
   * The not yet invoiced part of the customer's confirmed or completed sales orders with this entity: NPR, two
   * decimals, never negative. See uninvoicedOrderBalanceSql.
   */
  uninvoiced: string;
  /** The pending order's gross NPR value (with VAT), two decimals; '0.00' when the deal has none pending. */
  orderValue: string;
  /** exposure + uninvoiced + orderValue: what `held` compares with the limit. */
  exposureWithOrder: string;
  held: boolean;
}

/** The NPR snapshot columns of a quotation version (`quotation_versions`). */
export interface VersionNprSnapshot {
  currency: string;
  total: string;
  amountNpr: string | null;
}

/**
 * The order whose value counts on top of the receivables. `version`: the accepted version being confirmed (the
 * gate). `opportunityId`: the deal's accepted version that would be confirmed (the deal flag, the credit-hold page
 * and the override).
 */
export type PendingOrder = { version: VersionNprSnapshot } | { opportunityId: string };

/** Over the limit: strictly more than it. No limit is no hold; a 0.00 limit holds any positive amount. */
export function isOverLimit(creditLimit: string | null, exposure: string): boolean {
  return creditLimit !== null && new Decimal(exposure).gt(new Decimal(creditLimit));
}

/**
 * The gross NPR total an order of `version` carries: the version's NPR snapshot (`amount_npr`, VAT included, the
 * figure planDraftOrder copies to the order and its invoices then bill), NPR's own total when it is NPR, rounded
 * half-up to two decimals (D22). Gross like the receivables it is added to. An accepted version always has the
 * snapshot (quotation_versions check); one without it is a server error, never a value of zero.
 */
export function orderValueOf(version: VersionNprSnapshot): string {
  const amountNpr = version.amountNpr ?? (version.currency === 'NPR' ? version.total : null);
  if (amountNpr === null) throw new Error('quotation version has no NPR snapshot');
  return new Decimal(amountNpr).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Whether an override given for an order of `overrideOrderValue` still covers an order of `orderValue`: a later,
 * bigger order needs its own override. An override with no recorded value (given before the value was kept) covers
 * nothing, so it fails closed: the deal needs a new override.
 */
export function overrideCovers(overrideOrderValue: string | null, orderValue: string): boolean {
  return (
    overrideOrderValue !== null && new Decimal(overrideOrderValue).gte(new Decimal(orderValue))
  );
}

/**
 * What the customer's confirmed or completed sales orders with this entity have not billed yet (R5 FU4): per order,
 * its total less its issued tax invoices in the order's own currency (an invoice credited in full counts as not
 * billed, as its schedule line is free again), never below zero, converted to NPR at the order's rate and rounded
 * half-up to two decimals (D22), then summed. The remainder is worked out in the order's currency because an
 * invoice freezes its own NPR rate when it is issued: subtracting NPR snapshots taken at two rates would leave a
 * phantom balance (or hide a real one) on every foreign-currency order. A tax invoice enters the receivables when
 * it is issued and an order counts here only for what no issued invoice covers, so nothing is counted twice; a
 * draft, submitted or proforma invoice is no receivable and does not reduce it. A draft order (made on acceptance,
 * F1-Q25) is not confirmed and counts through the quotation's pending value instead (pendingOrderValue).
 *
 * A scalar subquery of the statement that also reads the receivables (see creditPosition): the two parts must see one
 * snapshot, or an invoice issued between two statements would leave both.
 */
function uninvoicedOrderBalanceSql(scope: TxScope, customerPartyId: string): SQL {
  return sql`(
    SELECT coalesce(sum(round(greatest(so.total - coalesce(billed.amount, 0), 0) * so.fx_rate, 2)), 0)::numeric(18, 2)::text
      FROM app.sales_orders so
      LEFT JOIN LATERAL (
             SELECT sum(i.total) AS amount
               FROM app.invoices i
              WHERE i.tenant_id = so.tenant_id
                AND i.organization_id = so.organization_id
                AND i.sales_order_id = so.id
                AND i.kind = 'tax_invoice'
                AND i.status = 'issued'
                AND i.currency = so.currency
                AND i.credited_in_full_at IS NULL) billed ON true
     WHERE so.tenant_id = ${scope.tenantId}::uuid
       AND so.organization_id = ${scope.organizationId}::uuid
       AND so.customer_party_id = ${customerPartyId}::uuid
       AND so.status IN ('confirmed', 'completed'))`;
}

/**
 * The pending order's value (see PendingOrder). A version's value counts only while its quotation has no confirmed
 * or completed sales order: once it has, the order's invoices are (or will be) the receivables, and counting the
 * quotation as well would count it twice. A draft order (made on acceptance, F1-Q25) is still pending. At the gate
 * the version being confirmed always counts (the confirm returns early for a quotation already ordered). For a
 * deal, its accepted versions still pending; none is zero, and of several (one per quotation) the largest counts,
 * so the deal is held whenever the gate would hold any of them and an override is never refused for a hold the
 * gate applies.
 */
export async function pendingOrderValue(
  tx: DbTransaction,
  scope: TxScope,
  pending: PendingOrder,
): Promise<string> {
  if ('version' in pending) return orderValueOf(pending.version);
  const rows = await tx.execute<{ currency: string; total: string; amount_npr: string | null }>(sql`
    SELECT v.currency, v.total::text AS total, v.amount_npr::text AS amount_npr
      FROM app.quotation_versions v
      JOIN app.quotations q
        ON q.tenant_id = v.tenant_id AND q.organization_id = v.organization_id AND q.id = v.quotation_id
     WHERE v.tenant_id = ${scope.tenantId}::uuid
       AND v.organization_id = ${scope.organizationId}::uuid
       AND q.opportunity_id = ${pending.opportunityId}::uuid
       AND v.status = 'accepted'
       AND NOT EXISTS (
             SELECT 1
               FROM app.sales_orders so
              WHERE so.tenant_id = q.tenant_id
                AND so.organization_id = q.organization_id
                AND so.quotation_id = q.id
                AND so.status IN ('confirmed', 'completed'))`);
  return rows.rows
    .map(
      (r) =>
        new Decimal(
          orderValueOf({ currency: r.currency, total: r.total, amountNpr: r.amount_npr }),
        ),
    )
    .reduce((max, v) => Decimal.max(max, v), new Decimal(0))
    .toFixed(2);
}

/**
 * The customer's credit position with the acting entity, counting `pending` (pendingOrderValue) on top of the
 * receivables. The receivables are its open receivable debits (invoices, debit notes) less
 * its open receivable credits (unapplied payments, credit notes), each converted at its own NPR rate
 * (`open_items.fx_rate`) and rounded half-up to two decimals on its own (D22; Postgres `round` takes a half away
 * from zero, so a credit rounds like a debit), then summed: the exposure is the sum of the NPR amounts a statement
 * shows, never a sum of unrounded fractions. Must run in a withTx transaction:
 * the ledger rows are read under the entity's row security, and a read outside one would see nothing, which would
 * read as "owes nothing" and never hold a deal.
 */
export async function creditPosition(
  tx: DbTransaction,
  scope: TxScope,
  customerPartyId: string,
  pending: PendingOrder,
): Promise<CreditPosition> {
  // One statement for everything that moves with an invoice being issued: the receivables, what the orders have not
  // invoiced, and the limit. Read as separate statements (read committed gives each its own snapshot), an invoice
  // issued between the two reads could drop out of both: absent from the receivables read before it, and already
  // subtracted from the orders' balance read after it (R5 FU6).
  const position = await tx.execute<{
    exposure: string;
    uninvoiced: string;
    credit_limit: string | null;
  }>(sql`
    SELECT (SELECT coalesce(sum(round(
                     CASE WHEN b.direction = 'debit' THEN b.open_amount ELSE -b.open_amount END * oi.fx_rate
                   , 2)), 0)::numeric(18, 2)::text
              FROM app.open_item_balances b
              JOIN app.open_items oi
                ON oi.tenant_id = b.tenant_id AND oi.organization_id = b.organization_id AND oi.id = b.open_item_id
             WHERE b.tenant_id = ${scope.tenantId}::uuid
               AND b.organization_id = ${scope.organizationId}::uuid
               AND b.side = 'receivable'
               AND b.customer_party_id = ${customerPartyId}::uuid) AS exposure,
           ${uninvoicedOrderBalanceSql(scope, customerPartyId)} AS uninvoiced,
           (SELECT credit_limit::text
              FROM app.party_accounts
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND organization_id = ${scope.organizationId}::uuid
               AND party_id = ${customerPartyId}::uuid) AS credit_limit`);
  const row = position.rows[0];
  const exposure = new Decimal(row?.exposure ?? '0').toFixed(2);
  const creditLimit = row?.credit_limit ?? null;
  const limit = creditLimit === null ? null : new Decimal(creditLimit).toFixed(2);
  const uninvoiced = new Decimal(row?.uninvoiced ?? '0').toFixed(2);
  const orderValue = await pendingOrderValue(tx, scope, pending);
  const exposureWithOrder = new Decimal(exposure).plus(uninvoiced).plus(orderValue).toFixed(2);
  return {
    creditLimit: limit,
    exposure,
    uninvoiced,
    orderValue,
    exposureWithOrder,
    held: isOverLimit(limit, exposureWithOrder),
  };
}
