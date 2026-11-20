// A deal's credit hold (F1-Q20, F1-Q26). The customer is over its credit limit when what it owes the acting entity
// now is more than the limit that entity gave it (`party_accounts.credit_limit`, NPR). Derived from the ledger on
// every read, never stored, so a payment or a new invoice changes it at once. The one rule for the opportunity's
// flag, the credit-hold page and the sales order gate.
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';

import type { DbTransaction, TxScope } from '../../platform/db/tx';

export interface CreditPosition {
  /** NPR, two decimals; null when the entity set no limit (then never held). */
  creditLimit: string | null;
  /** NPR, two decimals; may be negative when the customer is in credit. */
  exposure: string;
  held: boolean;
}

/** Over the limit: strictly more than it. No limit is no hold. */
export function isOverLimit(creditLimit: string | null, exposure: string): boolean {
  return creditLimit !== null && new Decimal(exposure).gt(new Decimal(creditLimit));
}

/**
 * The customer's credit position with the acting entity: its open receivable debits (invoices, debit notes) less
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
): Promise<CreditPosition> {
  const exposureRows = await tx.execute<{ exposure: string }>(sql`
    SELECT coalesce(sum(round(
             CASE WHEN b.direction = 'debit' THEN b.open_amount ELSE -b.open_amount END * oi.fx_rate
           , 2)), 0)::numeric(18, 2)::text AS exposure
      FROM app.open_item_balances b
      JOIN app.open_items oi
        ON oi.tenant_id = b.tenant_id AND oi.organization_id = b.organization_id AND oi.id = b.open_item_id
     WHERE b.tenant_id = ${scope.tenantId}::uuid
       AND b.organization_id = ${scope.organizationId}::uuid
       AND b.side = 'receivable'
       AND b.customer_party_id = ${customerPartyId}::uuid`);
  const limitRows = await tx.execute<{ credit_limit: string | null }>(sql`
    SELECT credit_limit::text AS credit_limit
      FROM app.party_accounts
     WHERE tenant_id = ${scope.tenantId}::uuid
       AND organization_id = ${scope.organizationId}::uuid
       AND party_id = ${customerPartyId}::uuid`);
  const exposure = new Decimal(exposureRows.rows[0]?.exposure ?? '0').toFixed(2);
  const creditLimit = limitRows.rows[0]?.credit_limit ?? null;
  const limit = creditLimit === null ? null : new Decimal(creditLimit).toFixed(2);
  return { creditLimit: limit, exposure, held: isOverLimit(limit, exposure) };
}
