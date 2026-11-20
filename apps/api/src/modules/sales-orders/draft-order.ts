// The draft sales order of an accepted quotation version (F1-Q25, Kuu 2026-11-20: "auto-create a draft for the
// Accountant to confirm"). Plain functions over the caller's transaction, so the quotation outcome (which runs in
// the portal's and the staff route's transactions) and SalesOrdersService.confirm build the draft the same way and
// neither module needs the other's providers.
//
// Planning reads only and refuses with a code (no NPR snapshot, a schedule that cannot be split, no customer);
// inserting writes the order, its lines, tax summary and schedule, every line `planned`: the advance becomes
// billable when the Accountant confirms the order, never on a draft. The draft has no number (the SO number is taken
// at confirm, sales_orders_number_status_check). One live order per quotation: the caller holds the quotation's row
// lock and checks first; sales_orders_one_live_per_quotation is the backstop.
import {
  billingScheduleLines,
  paymentTerms,
  quotationLines,
  type quotations,
  quotationTaxSummary,
  type quotationVersions,
  salesOrderLines,
  salesOrders,
  salesOrderTaxSummary,
  scoped,
} from '@bos/db';
import { and, asc, eq, ne } from 'drizzle-orm';

import { type AuditService } from '../../platform/audit/audit.service';
import { type DbTransaction } from '../../platform/db/db.module';
import { type TxScope } from '../../platform/db/tx';
import { type SettingsService } from '../../platform/settings/settings.service';
import {
  type PlannedScheduleLine,
  planSchedule,
  ScheduleRuleError,
  scheduleTemplateOf,
} from './rules';

type QuotationRow = typeof quotations.$inferSelect;
type VersionRow = typeof quotationVersions.$inferSelect;
type OrderRow = typeof salesOrders.$inferSelect;

/** Everything an order of `version` copies, read and checked before any write. */
export interface DraftPlan {
  customerPartyId: string;
  fxRate: string;
  amountNpr: string;
  creditDays: number;
  lines: (typeof quotationLines.$inferSelect)[];
  taxRows: (typeof quotationTaxSummary.$inferSelect)[];
  schedule: PlannedScheduleLine[];
}

/** Why an accepted version cannot become an order as it stands; the codes the confirm route answers 422 with. */
export interface DraftRefusal {
  code: 'invalid_payment_schedule' | 'no_npr_snapshot' | 'no_customer';
  message: string;
}

export type DraftPlanResult = { ok: true; plan: DraftPlan } | { ok: false; refusal: DraftRefusal };

/** Reads and checks what an order of `version` needs. Throws only on a database error. */
export async function planDraftOrder(
  tx: DbTransaction,
  scope: TxScope,
  settings: SettingsService,
  quotation: QuotationRow,
  version: VersionRow,
): Promise<DraftPlanResult> {
  const customerPartyId = quotation.customerPartyId;
  if (customerPartyId === null) {
    return {
      ok: false,
      refusal: { code: 'no_customer', message: `Quotation ${quotation.number} has no customer` },
    };
  }
  const isNpr = version.currency === 'NPR';
  const fxRate = version.fxRate ?? (isNpr ? '1' : null);
  const amountNpr = version.amountNpr ?? (isNpr ? version.total : null);
  if (fxRate === null || amountNpr === null) {
    return {
      ok: false,
      refusal: {
        code: 'no_npr_snapshot',
        message: `Quotation ${quotation.number} has no NPR rate snapshot`,
      },
    };
  }
  const defaultSchedule = await settings.get(scope, 'sales.default_schedule');
  let schedule: PlannedScheduleLine[];
  try {
    schedule = planSchedule(
      scheduleTemplateOf(version.paymentSchedule, defaultSchedule),
      version.total,
      amountNpr,
    );
  } catch (error) {
    if (error instanceof ScheduleRuleError) {
      return { ok: false, refusal: { code: 'invalid_payment_schedule', message: error.message } };
    }
    throw error;
  }
  const [lines, taxRows, creditDays] = await Promise.all([
    tx
      .select()
      .from(quotationLines)
      .where(scoped(scope).where(quotationLines, eq(quotationLines.versionId, version.id)))
      .orderBy(asc(quotationLines.lineNo)),
    tx
      .select()
      .from(quotationTaxSummary)
      .where(
        scoped(scope).where(quotationTaxSummary, eq(quotationTaxSummary.versionId, version.id)),
      ),
    creditDaysOf(tx, scope, version.paymentTermId),
  ]);
  return {
    ok: true,
    plan: { customerPartyId, fxRate, amountNpr, creditDays, lines, taxRows, schedule },
  };
}

/** Writes the draft order of `plan`; returns its id. Every schedule line starts `planned`. */
export async function insertDraftOrder(
  tx: DbTransaction,
  scope: TxScope,
  quotation: QuotationRow,
  version: VersionRow,
  plan: DraftPlan,
  createdBy: string | null,
): Promise<string> {
  const [created] = await tx
    .insert(salesOrders)
    .values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerPartyId: plan.customerPartyId,
      quotationId: quotation.id,
      quotationVersionId: version.id,
      status: 'draft',
      currency: version.currency as OrderRow['currency'],
      subtotal: version.subtotal,
      discountAmount: version.discountAmount,
      taxableAmount: version.taxableAmount,
      taxAmount: version.taxAmount,
      total: version.total,
      fxRate: plan.fxRate,
      fxSource: version.fxSource,
      fxDate: version.fxDate,
      amountNpr: plan.amountNpr,
      calcVersion: version.calcVersion,
      creditDays: plan.creditDays,
      createdBy,
    })
    .returning({ id: salesOrders.id });
  const orderId = created!.id;
  const own = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    salesOrderId: orderId,
  };
  if (plan.lines.length > 0) {
    await tx.insert(salesOrderLines).values(
      plan.lines.map((l) => ({
        ...own,
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        gross: l.gross,
        discountAlloc: l.discountAlloc,
        taxable: l.taxable,
      })),
    );
  }
  if (plan.taxRows.length > 0) {
    await tx.insert(salesOrderTaxSummary).values(
      plan.taxRows.map((t) => ({
        ...own,
        taxCodeId: t.taxCodeId,
        label: t.label,
        rate: t.rate,
        base: t.base,
        tax: t.tax,
      })),
    );
  }
  await tx.insert(billingScheduleLines).values(
    plan.schedule.map((l) => ({
      ...own,
      seq: l.seq,
      label: l.label,
      trigger: l.trigger,
      percent: l.percent,
      amount: l.amount,
      amountNpr: l.amountNpr,
      status: 'planned' as const,
    })),
  );
  return orderId;
}

/** The quotation's live (not cancelled) order, if any. The caller holds the quotation's row lock. */
export async function liveOrderOf(
  tx: DbTransaction,
  scope: TxScope,
  quotationId: string,
): Promise<Pick<OrderRow, 'id' | 'status' | 'quotationVersionId'> | undefined> {
  const [live] = await tx
    .select({
      id: salesOrders.id,
      status: salesOrders.status,
      quotationVersionId: salesOrders.quotationVersionId,
    })
    .from(salesOrders)
    .where(
      scoped(scope).where(
        salesOrders,
        and(eq(salesOrders.quotationId, quotationId), ne(salesOrders.status, 'cancelled')),
      ),
    );
  return live;
}

export type AutoDraftResult =
  | { drafted: true; orderId: string }
  | { drafted: false; reason: 'exists'; orderId: string }
  | { drafted: false; reason: 'refused'; refusal: DraftRefusal };

/**
 * F1-Q25: drafts the order of a version that was just accepted, inside the acceptance's transaction (the caller
 * holds the quotation's row lock). An order that already exists is left alone. A version that cannot become an
 * order is not drafted: the acceptance stands, the refusal is audited on the quotation and returned, so the caller
 * can tell the owner; the manual confirm route then answers the same 422 until the cause is fixed. A database error
 * is not caught: it rolls the acceptance back, and the caller's Idempotency-Key makes the retry safe.
 */
export async function draftOrderOnAcceptance(
  tx: DbTransaction,
  scope: TxScope,
  deps: { settings: SettingsService; audit: AuditService },
  quotation: QuotationRow,
  version: VersionRow,
  createdBy: string | null,
): Promise<AutoDraftResult> {
  const live = await liveOrderOf(tx, scope, quotation.id);
  if (live !== undefined) return { drafted: false, reason: 'exists', orderId: live.id };
  const planned = await planDraftOrder(tx, scope, deps.settings, quotation, version);
  if (!planned.ok) {
    await deps.audit.record(tx, {
      action: 'sales_order.draft_refused',
      entityType: 'quotations',
      entityId: quotation.id,
      before: null,
      after: { versionId: version.id, code: planned.refusal.code, reason: planned.refusal.message },
    });
    return { drafted: false, reason: 'refused', refusal: planned.refusal };
  }
  const orderId = await insertDraftOrder(tx, scope, quotation, version, planned.plan, createdBy);
  await deps.audit.record(tx, {
    action: 'sales_order.drafted',
    entityType: 'sales_orders',
    entityId: orderId,
    before: null,
    after: {
      quotationId: quotation.id,
      quotationVersionId: version.id,
      total: version.total,
      schedule: planned.plan.schedule.map((l) => ({
        label: l.label,
        trigger: l.trigger,
        amount: l.amount,
      })),
    },
  });
  return { drafted: true, orderId };
}

async function creditDaysOf(
  tx: DbTransaction,
  scope: TxScope,
  paymentTermId: string | null,
): Promise<number> {
  if (paymentTermId === null) return 0;
  const [term] = await tx
    .select({ netDays: paymentTerms.netDays })
    .from(paymentTerms)
    .where(and(eq(paymentTerms.tenantId, scope.tenantId), eq(paymentTerms.id, paymentTermId)));
  return term?.netDays ?? 0;
}
