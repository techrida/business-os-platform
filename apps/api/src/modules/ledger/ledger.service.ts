// LedgerService: the single writer of the AR/AP subledger (P3 plan U0-B; decisions A1, A8, A9, A13). Every
// method runs in the caller's transaction (from withTx), after the caller's own locks and before its outbox write
// (section 2 "Money commands", steps 3 and 6). Nothing here opens a transaction or commits.
//
// open_items, open_item_allocations and posting_events are append-only; replays insert with ON CONFLICT DO NOTHING
// and read the existing row back. Paid is never stored: open amounts come from the open_item_balances view.
// ledger-writers.test.ts keeps every other module from writing these tables.
import {
  openItemAllocations,
  openItemBalances,
  openItems,
  postingEvents,
  type POSTING_EVENT_SOURCE_TYPES,
} from '@bos/db';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import type { Actor, DbTransaction, TxScope } from '../../platform/db/tx';
import { type LockRank, type LockStep, LockOrderError, planLocks } from './lock-order';
import type { PostingEvent } from './posting-events';

export type OpenItem = typeof openItems.$inferSelect;
export type OpenItemAllocation = typeof openItemAllocations.$inferSelect;
export type PostingEventRow = typeof postingEvents.$inferSelect;
export type PostingEventSourceType = (typeof POSTING_EVENT_SOURCE_TYPES)[number];

/**
 * Domain error codes of the ledger. @bos/contracts has no code list for these yet, so they live here; the body is
 * `{ code, message, details? }` like the other domain errors (NO_ELIGIBLE_APPROVER).
 */
export const LEDGER_ERROR_CODES = {
  OVER_ALLOCATION: HttpStatus.CONFLICT,
  MISMATCHED_ITEMS: HttpStatus.UNPROCESSABLE_ENTITY,
  OPEN_ITEM_CONFLICT: HttpStatus.CONFLICT,
  OPEN_ITEM_NOT_FOUND: HttpStatus.NOT_FOUND,
  ALLOCATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ALLOCATION_NOT_REVERSIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  REASON_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
} as const;
export type LedgerErrorCode = keyof typeof LEDGER_ERROR_CODES;

export class LedgerError extends HttpException {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, LEDGER_ERROR_CODES[code]);
  }
}

export interface OpenItemInput {
  side: OpenItem['side'];
  direction: OpenItem['direction'];
  /** The customer (receivable side) or vendor (payable side) party; it lands in the matching column (A9). */
  partyId: string;
  sourceType: OpenItem['sourceType'];
  sourceId: string;
  currency: OpenItem['currency'];
  /** Positive, in the document currency, at most 2 decimals. */
  amount: string;
  amountNpr: string;
  /** NPR per unit of currency; '1' for NPR. */
  fxRate: string;
  fxSource?: string | null;
  fxDate?: string | null;
  documentDate: string;
  dueDate?: string | null;
}

export interface AllocateInput {
  debitItemId: string;
  creditItemId: string;
  /** Positive, at most 2 decimals, in the items' shared currency. */
  amount: string;
}

export interface ReverseAllocationInput {
  allocationId: string;
  reason: string;
}

export interface RecordEventInput {
  sourceType: PostingEventSourceType;
  sourceId: string;
  event: PostingEvent;
  payload?: Record<string, unknown>;
}

/** One step of lockForMoneyCommand. `table` is required except for open_item (it defaults to open_items). */
export interface MoneyLockStep extends LockStep {
  table?: PgTable;
}

/** created_by is a uuid FK to app.users; a system or seed actor is recorded as NULL. */
function createdBy(actor: Actor): string | null {
  return actor.kind === 'user' ? actor.id : null;
}

function positiveMoney(amount: string, what: string): string {
  let value: Decimal;
  try {
    value = new Decimal(amount);
  } catch {
    throw new LedgerError('INVALID_AMOUNT', `${what} is not a number`);
  }
  if (!value.isFinite() || value.lte(0) || value.decimalPlaces() > 2) {
    throw new LedgerError('INVALID_AMOUNT', `${what} must be positive with at most 2 decimals`);
  }
  return value.toFixed(2);
}

function sameMoney(a: string, b: string): boolean {
  return new Decimal(a).eq(new Decimal(b));
}

@Injectable()
export class LedgerService {
  /**
   * Opens the item a source document leaves owed. Idempotent per (source_type, source_id): a replay with the same
   * side, direction, party, currency and amount returns the existing row (`created: false`); a replay that differs
   * throws OPEN_ITEM_CONFLICT.
   */
  async openItem(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    input: OpenItemInput,
  ): Promise<{ item: OpenItem; created: boolean }> {
    const amount = positiveMoney(input.amount, 'amount');
    const receivable = input.side === 'receivable';
    const [inserted] = await tx
      .insert(openItems)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        side: input.side,
        direction: input.direction,
        customerPartyId: receivable ? input.partyId : null,
        vendorPartyId: receivable ? null : input.partyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        currency: input.currency,
        amount,
        amountNpr: input.amountNpr,
        fxRate: input.fxRate,
        fxSource: input.fxSource ?? null,
        fxDate: input.fxDate ?? null,
        documentDate: input.documentDate,
        dueDate: input.dueDate ?? null,
        createdBy: createdBy(actor),
      })
      .onConflictDoNothing({
        target: [
          openItems.tenantId,
          openItems.organizationId,
          openItems.sourceType,
          openItems.sourceId,
        ],
      })
      .returning();
    if (inserted) return { item: inserted, created: true };

    const [existing] = await tx
      .select()
      .from(openItems)
      .where(
        and(
          eq(openItems.tenantId, scope.tenantId),
          eq(openItems.organizationId, scope.organizationId),
          eq(openItems.sourceType, input.sourceType),
          eq(openItems.sourceId, input.sourceId),
        ),
      );
    if (!existing) {
      throw new Error(
        `open item for ${input.sourceType} ${input.sourceId} conflicted but cannot be read`,
      );
    }
    const existingParty = existing.customerPartyId ?? existing.vendorPartyId;
    if (
      existing.side !== input.side ||
      existing.direction !== input.direction ||
      existingParty !== input.partyId ||
      existing.currency !== input.currency ||
      !sameMoney(existing.amount, amount)
    ) {
      throw new LedgerError(
        'OPEN_ITEM_CONFLICT',
        `${input.sourceType} ${input.sourceId} already has an open item with a different side, direction, party, currency or amount`,
        { openItemId: existing.id },
      );
    }
    return { item: existing, created: false };
  }

  /**
   * Allocates a credit item against a debit item of the same side, party and currency. Locks both items in
   * ascending id order, then rechecks their open amounts in a fresh statement (READ COMMITTED: it sees what a
   * concurrent allocator committed while this one waited), so a loser gets OVER_ALLOCATION here instead of the
   * cap trigger's check_violation at commit. Records the `allocation` posting event keyed by the new row.
   */
  async allocate(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    input: AllocateInput,
  ): Promise<OpenItemAllocation> {
    const amount = positiveMoney(input.amount, 'allocation amount');
    if (input.debitItemId === input.creditItemId) {
      throw new LedgerError('MISMATCHED_ITEMS', 'an item cannot be allocated against itself');
    }
    await this.lockOpenItems(tx, scope, [input.debitItemId, input.creditItemId]);
    const balances = await this.balances(tx, scope, [input.debitItemId, input.creditItemId]);
    const debit = balances.get(input.debitItemId);
    const credit = balances.get(input.creditItemId);
    if (!debit || !credit) {
      throw new LedgerError('OPEN_ITEM_NOT_FOUND', 'open item not found');
    }
    if (
      debit.direction !== 'debit' ||
      credit.direction !== 'credit' ||
      debit.side !== credit.side ||
      debit.customerPartyId !== credit.customerPartyId ||
      debit.vendorPartyId !== credit.vendorPartyId ||
      debit.currency !== credit.currency
    ) {
      throw new LedgerError(
        'MISMATCHED_ITEMS',
        'allocation needs a debit and a credit item of the same side, party and currency',
        { debitItemId: debit.openItemId, creditItemId: credit.openItemId },
      );
    }
    const wanted = new Decimal(amount);
    if (wanted.gt(debit.openAmount) || wanted.gt(credit.openAmount)) {
      throw new LedgerError('OVER_ALLOCATION', 'the allocation exceeds an open amount', {
        amount,
        debitOpenAmount: debit.openAmount,
        creditOpenAmount: credit.openAmount,
      });
    }

    const [allocation] = await tx
      .insert(openItemAllocations)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        debitItemId: input.debitItemId,
        creditItemId: input.creditItemId,
        amount,
        createdBy: createdBy(actor),
      })
      .returning();
    if (!allocation) throw new Error('allocation insert returned no row');
    await this.recordEvent(tx, scope, actor, {
      sourceType: 'allocation',
      sourceId: allocation.id,
      event: 'allocation',
      payload: {
        debitItemId: allocation.debitItemId,
        creditItemId: allocation.creditItemId,
        amount: allocation.amount,
        currency: debit.currency,
      },
    });
    return allocation;
  }

  /**
   * Reverses one forward allocation with an exactly negated row that names it and a reason. Idempotent through
   * the unique reverses_allocation_id: a replay returns the existing reversal (`created: false`). Records the
   * `allocation_reversed` posting event keyed by the reversal row.
   */
  async reverseAllocation(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    input: ReverseAllocationInput,
  ): Promise<{ allocation: OpenItemAllocation; created: boolean }> {
    const reason = input.reason.trim();
    if (reason === '') throw new LedgerError('REASON_REQUIRED', 'a reversal needs a reason');
    const original = await this.allocationById(tx, scope, input.allocationId);
    if (!original) throw new LedgerError('ALLOCATION_NOT_FOUND', 'allocation not found');
    if (original.reversesAllocationId !== null) {
      throw new LedgerError('ALLOCATION_NOT_REVERSIBLE', 'a reversal cannot itself be reversed');
    }
    await this.lockOpenItems(tx, scope, [original.debitItemId, original.creditItemId]);

    const [inserted] = await tx
      .insert(openItemAllocations)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        debitItemId: original.debitItemId,
        creditItemId: original.creditItemId,
        amount: new Decimal(original.amount).neg().toFixed(2),
        reversesAllocationId: original.id,
        reason,
        createdBy: createdBy(actor),
      })
      .onConflictDoNothing({
        target: [openItemAllocations.tenantId, openItemAllocations.reversesAllocationId],
      })
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(openItemAllocations)
        .where(
          and(
            eq(openItemAllocations.tenantId, scope.tenantId),
            eq(openItemAllocations.organizationId, scope.organizationId),
            eq(openItemAllocations.reversesAllocationId, original.id),
          ),
        );
      if (!existing) throw new Error(`reversal of ${original.id} conflicted but cannot be read`);
      return { allocation: existing, created: false };
    }
    await this.recordEvent(tx, scope, actor, {
      sourceType: 'allocation',
      sourceId: inserted.id,
      event: 'allocation_reversed',
      payload: {
        reversesAllocationId: original.id,
        debitItemId: inserted.debitItemId,
        creditItemId: inserted.creditItemId,
        amount: inserted.amount,
        reason,
      },
    });
    return { allocation: inserted, created: true };
  }

  /**
   * Records a business event once per (source_type, source_id, event). A replay returns the stored row
   * (`created: false`) and keeps its original payload.
   */
  async recordEvent(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    input: RecordEventInput,
  ): Promise<{ event: PostingEventRow; created: boolean }> {
    const [inserted] = await tx
      .insert(postingEvents)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        event: input.event,
        payload: input.payload ?? {},
        createdBy: createdBy(actor),
      })
      .onConflictDoNothing({
        target: [
          postingEvents.tenantId,
          postingEvents.organizationId,
          postingEvents.sourceType,
          postingEvents.sourceId,
          postingEvents.event,
        ],
      })
      .returning();
    if (inserted) return { event: inserted, created: true };
    const [existing] = await tx
      .select()
      .from(postingEvents)
      .where(
        and(
          eq(postingEvents.tenantId, scope.tenantId),
          eq(postingEvents.organizationId, scope.organizationId),
          eq(postingEvents.sourceType, input.sourceType),
          eq(postingEvents.sourceId, input.sourceId),
          eq(postingEvents.event, input.event),
        ),
      );
    if (!existing) throw new Error(`posting event ${input.event} conflicted but cannot be read`);
    return { event: existing, created: false };
  }

  /** Open amount (decimal string) of each id found in this entity. An unknown id is absent, never 0. */
  async openAmounts(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const balances = await this.balances(tx, scope, ids);
    return new Map([...balances].map(([id, row]) => [id, row.openAmount]));
  }

  /**
   * Takes the row locks of a money command in the documented order (lock-order.ts): each step's rows in
   * ascending id order with SELECT ... FOR UPDATE, one table per step. Throws LockOrderError on a step out of
   * order. Returns the ids actually locked per rank; an id missing from the result does not exist in this entity.
   */
  async lockForMoneyCommand(
    tx: DbTransaction,
    scope: TxScope,
    steps: readonly MoneyLockStep[],
  ): Promise<Partial<Record<LockRank, string[]>>> {
    const tables = new Map<LockRank, PgTable>();
    for (const step of steps) {
      const table = step.table ?? (step.rank === 'open_item' ? openItems : undefined);
      if (!table) throw new LockOrderError(`lock step ${step.rank} needs its table`);
      tables.set(step.rank, table);
    }
    const locked: Partial<Record<LockRank, string[]>> = {};
    for (const step of planLocks(steps)) {
      const table = tables.get(step.rank);
      if (!table) throw new LockOrderError(`lock step ${step.rank} needs its table`);
      const ids = sql.join(
        step.ids.map((id) => sql`${id}`),
        sql`, `,
      );
      const result = await tx.execute<{ id: string }>(
        sql`SELECT "id" FROM ${table}
            WHERE "tenant_id" = ${scope.tenantId} AND "organization_id" = ${scope.organizationId}
              AND "id" IN (${ids})
            ORDER BY "id" FOR UPDATE`,
      );
      locked[step.rank] = result.rows.map((row) => row.id);
    }
    return locked;
  }

  private async lockOpenItems(tx: DbTransaction, scope: TxScope, ids: string[]): Promise<void> {
    const locked = await this.lockForMoneyCommand(tx, scope, [{ rank: 'open_item', ids }]);
    if ((locked.open_item ?? []).length !== new Set(ids).size) {
      throw new LedgerError('OPEN_ITEM_NOT_FOUND', 'open item not found');
    }
  }

  private async balances(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<Map<string, typeof openItemBalances.$inferSelect>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(openItemBalances)
      .where(
        and(
          eq(openItemBalances.tenantId, scope.tenantId),
          eq(openItemBalances.organizationId, scope.organizationId),
          inArray(openItemBalances.openItemId, [...ids]),
        ),
      );
    return new Map(rows.map((row) => [row.openItemId, row]));
  }

  private async allocationById(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
  ): Promise<OpenItemAllocation | undefined> {
    const [row] = await tx
      .select()
      .from(openItemAllocations)
      .where(
        and(
          eq(openItemAllocations.tenantId, scope.tenantId),
          eq(openItemAllocations.organizationId, scope.organizationId),
          eq(openItemAllocations.id, id),
        ),
      );
    return row;
  }
}
