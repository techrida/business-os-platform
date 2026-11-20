// The settlement and open amount of a page of invoices (D56 U15b-Q2), read in one query inside the caller's
// transaction. Nothing is stored: like the statement, each state comes from the invoice's open item and its
// allocations through `settlementOf` (money-rules), so a list row agrees with the invoice list's Payment filter
// and the customer statement. Only issued tax invoices and debit notes have an open item; others are left out.
import type { InvoiceKind, InvoiceStatus, SettlementStatus } from '@bos/contracts';
import { invoices, openItemBalances } from '@bos/db';
import { Dec, settlementOf } from '@bos/money-rules';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';

/** Invoice ids bound per statement. */
const ID_BATCH = 5000;
const SETTLEMENT_KINDS: readonly InvoiceKind[] = ['tax_invoice', 'debit_note'];

export interface InvoiceSettlementState {
  settlement: SettlementStatus;
  /** What is still owed, in the invoice's currency, to 2 decimals. */
  openAmount: string;
}

/** The invoice fields this read needs; the list's own row has them. */
export interface SettlementSubject {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
}

/**
 * The state of each issued tax invoice or debit note among `subjects`, keyed by invoice id, as of `today` (the
 * Kathmandu day). An invoice without a due date is due on its issue date, as in the statement.
 */
export async function invoiceSettlements(
  tx: DbTransaction,
  scope: TxScope,
  subjects: readonly SettlementSubject[],
  today: string,
): Promise<Map<string, InvoiceSettlementState>> {
  const ids = subjects
    .filter((s) => s.status === 'issued' && SETTLEMENT_KINDS.includes(s.kind))
    .map((s) => s.id);
  const states = new Map<string, InvoiceSettlementState>();
  if (ids.length === 0) return states;
  // The net of allocations on the debit item whose credit item is a credit note, reversals included.
  const credited = sql<string>`(
    SELECT COALESCE(sum(a."amount"), 0)::text
      FROM "app"."open_item_allocations" a
      JOIN "app"."open_items" c ON c."tenant_id" = a."tenant_id" AND c."id" = a."credit_item_id"
     WHERE a."tenant_id" = ${openItemBalances.tenantId}
       AND a."organization_id" = ${openItemBalances.organizationId}
       AND a."debit_item_id" = ${openItemBalances.openItemId}
       AND c."source_type" = 'credit_note')`;
  const readChunk = (chunk: string[]) =>
    tx
      .select({
        id: invoices.id,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        total: openItemBalances.amount,
        open: openItemBalances.openAmount,
        credited,
      })
      .from(invoices)
      .innerJoin(
        openItemBalances,
        and(
          eq(openItemBalances.tenantId, invoices.tenantId),
          eq(openItemBalances.organizationId, invoices.organizationId),
          eq(openItemBalances.sourceId, invoices.id),
          sql`${openItemBalances.sourceType} = ${invoices.kind}`,
        ),
      )
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          inArray(invoices.id, chunk),
        ),
      );
  // An unpaginated list can hold more ids than one statement may bind (65,535 parameters), so read in batches.
  const rows: Awaited<ReturnType<typeof readChunk>> = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    rows.push(...(await readChunk(ids.slice(i, i + ID_BATCH))));
  }
  for (const r of rows) {
    const open = new Dec(r.open);
    states.set(r.id, {
      settlement: settlementOf({
        total: new Dec(r.total),
        openAmount: open,
        dueDate: r.dueDate ?? r.issueDate ?? today,
        today,
        credited: new Dec(r.credited),
      }),
      openAmount: open.toFixed(2),
    });
  }
  return states;
}
