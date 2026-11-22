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
  /**
   * The quotation version whose value `orderValue` is: for a deal, its largest pending accepted version (of equal
   * values, the lowest id); for a version (the gate, and the override action for the version it is given for), that
   * version when the caller passed its id. Null when there is none.
   */
  pendingQuotationVersionId: string | null;
}

/** The NPR snapshot columns of a quotation version (`quotation_versions`), and its id when the caller has it. */
export interface VersionNprSnapshot {
  id?: string;
  currency: string;
  total: string;
  amountNpr: string | null;
}

/**
 * The order whose value counts on top of the receivables. `version`: the accepted version being confirmed (the
 * gate), or the one an override is given for (the override action, R5 FU10). `opportunityId`: the deal's accepted
 * version that would be confirmed (the deal flag and the credit-hold page).
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

/** The quotation version and order value an override was given for, or an order that is pending now. */
export interface OverrideTarget {
  versionId: string | null;
  orderValue: string | null;
}

/**
 * Whether an override given for `override` (a quotation version and an order value) covers the order `pending` is
 * now: exactly that version at exactly that value (R5 FU10). A second order on the deal, a new version, or the same
 * version at another value (bigger or smaller) needs its own override. An override with no recorded version or value
 * (given before either was kept) covers nothing, so it fails closed: the deal needs a new override. Nothing pending
 * is nothing covered. The one rule for the gate, the override action and the deal's flag and credit-hold page.
 */
export function overrideCovers(override: OverrideTarget, pending: OverrideTarget): boolean {
  // `== null`, not `=== null`: a missing field is no recorded version or value either.
  if (override.versionId == null || override.orderValue == null) return false;
  if (pending.versionId == null || pending.orderValue == null) return false;
  return (
    override.versionId === pending.versionId &&
    new Decimal(override.orderValue).eq(new Decimal(pending.orderValue))
  );
}

/**
 * What the customer's confirmed or completed sales orders with this entity have not billed yet (R5 FU4): per order,
 * its total less its issued tax invoices in the order's own currency (an invoice credited in full counts as not
 * billed, as its schedule line is free again; one credited in part counts only for what its issued credit notes in
 * the same currency left, R5 FU10), never below zero, converted to NPR at the order's rate and rounded
 * half-up to two decimals (D22), then summed. The remainder is worked out in the order's currency because an
 * invoice freezes its own NPR rate when it is issued: subtracting NPR snapshots taken at two rates would leave a
 * phantom balance (or hide a real one) on every foreign-currency order. A tax invoice enters the receivables when
 * it is issued and an order counts here only for what no issued invoice covers, so nothing is counted twice; a
 * draft, submitted or proforma invoice is no receivable and does not reduce it. A draft order (made on acceptance,
 * F1-Q25) is not confirmed and counts through the quotation's pending value instead (pendingVersionsSql).
 *
 * A credit note offsets its invoice in the receivables (an open credit against the invoice's debit), and the part it
 * frees counts here once as uninvoiced, so nothing is counted twice and nothing drops out: a 100.00 order invoiced in
 * full with 40.00 credited is 60.00 receivable plus 40.00 uninvoiced, 100.00 in all, the same as a full credit gives
 * (0.00 receivable plus 100.00 uninvoiced). A draft or approved credit note offsets nothing in the receivables yet,
 * so it frees nothing here either. A note carries its original's currency (note drafting copies it); the currency
 * test only keeps the subtraction in one currency, like the invoices' own.
 *
 * A scalar subquery of the statement that also reads the receivables (see creditPosition): the two parts must see one
 * snapshot, or an invoice issued between two statements would leave both.
 */
function uninvoicedOrderBalanceSql(scope: TxScope, customerPartyId: string): SQL {
  return sql`(
    SELECT coalesce(sum(round(greatest(so.total - coalesce(billed.amount, 0), 0) * so.fx_rate, 2)), 0)::numeric(18, 2)::text
      FROM app.sales_orders so
      LEFT JOIN LATERAL (
             SELECT sum(greatest(i.total - coalesce(credited.amount, 0), 0)) AS amount
               FROM app.invoices i
               LEFT JOIN LATERAL (
                      SELECT sum(cn.total) AS amount
                        FROM app.invoices cn
                       WHERE cn.tenant_id = i.tenant_id
                         AND cn.organization_id = i.organization_id
                         AND cn.original_invoice_id = i.id
                         AND cn.kind = 'credit_note'
                         AND cn.status = 'issued'
                         AND cn.currency = i.currency) credited ON true
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
 * gate applies; of equal values the lowest version id counts, so the version named is stable.
 *
 * For a deal, a scalar subquery of the statement that reads the receivables (see creditPosition): the deal's versions
 * as a JSON array ordered by id, valued in TS by orderValueOf (pendingOf). For the gate, NULL: the caller passed the
 * version.
 */
function pendingVersionsSql(scope: TxScope, pending: PendingOrder): SQL {
  if ('version' in pending) return sql`NULL::json`;
  return sql`(
    SELECT json_agg(json_build_object(
             'id', v.id, 'currency', v.currency, 'total', v.total::text, 'amountNpr', v.amount_npr::text
           ) ORDER BY v.id)
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
                AND so.status IN ('confirmed', 'completed')))`;
}

/** The pending order's value and version (see pendingVersionsSql), from the rows it read for a deal. */
function pendingOf(
  pending: PendingOrder,
  versions: (VersionNprSnapshot & { id: string })[] | null,
): { orderValue: string; versionId: string | null } {
  if ('version' in pending) {
    return { orderValue: orderValueOf(pending.version), versionId: pending.version.id ?? null };
  }
  let largest: { value: Decimal; versionId: string | null } = {
    value: new Decimal(0),
    versionId: null,
  };
  // Ordered by id: only a strictly larger value replaces the one held, so of equal values the lowest id stays.
  for (const version of versions ?? []) {
    const value = new Decimal(orderValueOf(version));
    if (largest.versionId === null || value.gt(largest.value)) {
      largest = { value, versionId: version.id };
    }
  }
  return { orderValue: largest.value.toFixed(2), versionId: largest.versionId };
}

/**
 * The customer's credit position with the acting entity, counting `pending` (pendingVersionsSql) on top of the
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
  // One statement for everything that moves with an invoice being issued or an order being confirmed: the
  // receivables, what the orders have not invoiced, the deal's pending versions, and the limit. Read as separate
  // statements (read committed gives each its own snapshot), an invoice issued between two reads could drop out of
  // both: absent from the receivables read before it, and already subtracted from the orders' balance read after it
  // (R5 FU6); and an order confirmed between two reads could drop out of both too: missing from the orders' balance
  // read before it, and no longer pending in the read after it (R5 FU10).
  const position = await tx.execute<{
    exposure: string;
    uninvoiced: string;
    credit_limit: string | null;
    pending_versions: (VersionNprSnapshot & { id: string })[] | null;
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
               AND party_id = ${customerPartyId}::uuid) AS credit_limit,
           ${pendingVersionsSql(scope, pending)} AS pending_versions`);
  const row = position.rows[0];
  const exposure = new Decimal(row?.exposure ?? '0').toFixed(2);
  const creditLimit = row?.credit_limit ?? null;
  const limit = creditLimit === null ? null : new Decimal(creditLimit).toFixed(2);
  const uninvoiced = new Decimal(row?.uninvoiced ?? '0').toFixed(2);
  const { orderValue, versionId } = pendingOf(pending, row?.pending_versions ?? null);
  const exposureWithOrder = new Decimal(exposure).plus(uninvoiced).plus(orderValue).toFixed(2);
  return {
    creditLimit: limit,
    exposure,
    uninvoiced,
    orderValue,
    exposureWithOrder,
    held: isOverLimit(limit, exposureWithOrder),
    pendingQuotationVersionId: versionId,
  };
}
