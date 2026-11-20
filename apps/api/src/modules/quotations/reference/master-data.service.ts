// MasterDataService: Settings edits of the tenant's tax codes and payment terms (F1-Q49). Both lists are
// tenant-level (ADR 0027 section 6). Every write runs in withTx, so the row trigger audits it, and records a domain
// event naming what changed.
// - Tax codes: a code is a series of dated periods. A change closes the last period on day D (today or later, in
//   Asia/Kathmandu) and adds a period from D; retiring closes the last period. No period is ever edited or deleted,
//   so a document keeps the period row it was priced with (rules and their tests: tax-code-periods.ts).
// - Payment terms: days are fixed at creation, because sales orders, vendor bills and purchase requests read them
//   from the term. The name can be corrected; a term is retired (no longer offered) or restored, never deleted.
import {
  type AdminPaymentTerm,
  type AdminTaxCode,
  type ChangeTaxCodeBody,
  type CreatePaymentTermBody,
  type CreateTaxCodeBody,
  percentToBasisPoints,
  type RetireTaxCodeBody,
  TAX_RATE_KIND_MESSAGE,
  taxRateFitsKind,
  type UpdatePaymentTermBody,
} from '@bos/contracts';
import { paymentTerms, taxCodes } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import { MasterDataCaller } from './master-data.caller';
import { kathmanduDay } from './reference.types';
import {
  type PeriodRefusal,
  planTaxCodeChange,
  planTaxCodeRetire,
  summariseTaxCodes,
  type TaxCodePeriodRow,
} from './tax-code-periods';

const periodColumns = {
  id: taxCodes.id,
  code: taxCodes.code,
  name: taxCodes.name,
  kind: taxCodes.kind,
  rateBp: taxCodes.rateBp,
  creditable: taxCodes.creditable,
  effectiveFrom: taxCodes.effectiveFrom,
  effectiveTo: taxCodes.effectiveTo,
  version: taxCodes.version,
};

const termColumns = {
  id: paymentTerms.id,
  code: paymentTerms.code,
  name: paymentTerms.name,
  netDays: paymentTerms.netDays,
  isActive: paymentTerms.isActive,
  version: paymentTerms.version,
};

type TermRow = {
  id: string;
  code: string;
  name: string;
  netDays: number;
  isActive: boolean;
  version: number;
};

const toTerm = (row: TermRow): AdminPaymentTerm => ({
  id: row.id,
  code: row.code,
  name: row.name,
  netDays: row.netDays,
  retired: !row.isActive,
  version: row.version,
});

/** The Postgres error code under a driver or Drizzle wrapper. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  const e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | null;
  const source = typeof e?.code === 'string' ? e : (e?.cause as typeof e);
  return {
    ...(typeof source?.code === 'string' ? { code: source.code } : {}),
    ...(typeof source?.constraint === 'string' ? { constraint: source.constraint } : {}),
  };
}

function refused(refusal: PeriodRefusal): Error {
  const body = {
    code:
      refusal.status === 404 ? 'not_found' : refusal.status === 409 ? 'conflict' : 'bad_request',
    message: refusal.message,
  };
  if (refusal.status === 404) return new NotFoundException(body);
  if (refusal.status === 409) return new ConflictException(body);
  return new BadRequestException(body);
}

const codeTaken = (code: string) =>
  new ConflictException({ code: 'conflict', message: `The tax code ${code} already exists.` });

const termNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Payment term not found' });

@Injectable()
export class MasterDataService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly caller: MasterDataCaller,
  ) {}

  /** 403 unless the caller may edit finance settings; the routes call it before parsing the body. */
  assertEditor(): void {
    this.caller.assertEditor();
  }

  /** Today in Asia/Kathmandu: the first day a change or retirement may take effect. */
  protected today(): string {
    return kathmanduDay(new Date());
  }

  // ------------------------------------------------------------------------------------------- tax codes

  /** Every code with every period (past, in force and scheduled, retired ones included). */
  async listTaxCodes(): Promise<AdminTaxCode[]> {
    this.caller.assertEditor();
    const { scope } = this.caller.current();
    const rows = await this.db
      .select(periodColumns)
      .from(taxCodes)
      .where(eq(taxCodes.tenantId, scope.tenantId))
      .orderBy(asc(taxCodes.code), asc(taxCodes.effectiveFrom));
    return summariseTaxCodes(rows, this.today());
  }

  /** 201 with the new code. 409 when the code already exists; 400 for a start before today. */
  async createTaxCode(body: CreateTaxCodeBody): Promise<AdminTaxCode> {
    this.caller.assertEditor();
    const today = this.today();
    if (body.effectiveFrom < today) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'A new tax code cannot start before today.',
      });
    }
    const { scope, actor } = this.caller.current();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const existing = await this.periods(tx, scope.tenantId, body.code);
        if (existing.length > 0) throw codeTaken(body.code);
        const [created] = await tx
          .insert(taxCodes)
          .values({
            tenantId: scope.tenantId,
            code: body.code,
            name: body.name,
            kind: body.kind,
            rateBp: percentToBasisPoints(body.rate),
            creditable: body.creditable,
            effectiveFrom: body.effectiveFrom,
            effectiveTo: null,
          })
          .returning({ id: taxCodes.id });
        await this.audit.record(tx, {
          action: 'tax_code.created',
          entityType: 'tax_codes',
          entityId: created!.id,
          after: { ...body },
        });
        return this.codeSummary(tx, scope.tenantId, body.code, today);
      });
    } catch (error) {
      // Two people adding the same code at once: the second open-ended period overlaps the first.
      if (pgError(error).code === '23P01') throw codeTaken(body.code);
      throw error;
    }
  }

  /** 201 with the code: a new period from `effectiveFrom`, the last period closed that day. */
  async changeTaxCode(code: string, body: ChangeTaxCodeBody): Promise<AdminTaxCode> {
    this.caller.assertEditor();
    const today = this.today();
    const { scope, actor } = this.caller.current();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const periods = await this.periods(tx, scope.tenantId, code, true);
        const plan = planTaxCodeChange(periods, {
          effectiveFrom: body.effectiveFrom,
          expectedVersion: body.expectedVersion,
          today,
        });
        if (!plan.ok) throw refused(plan);
        const latest = periods.find((p) => p.id === plan.close.id)!;
        const rateBp = percentToBasisPoints(body.rate);
        if (!taxRateFitsKind(latest.kind, rateBp)) {
          throw new BadRequestException({ code: 'bad_request', message: TAX_RATE_KIND_MESSAGE });
        }
        await updateVersioned(tx, taxCodes, plan.close.id, plan.close.version, {
          effectiveTo: plan.close.effectiveTo,
          updatedAt: new Date(),
        });
        const [added] = await tx
          .insert(taxCodes)
          .values({
            tenantId: scope.tenantId,
            code: latest.code,
            name: body.name,
            kind: latest.kind,
            rateBp,
            creditable: body.creditable,
            effectiveFrom: body.effectiveFrom,
            effectiveTo: null,
          })
          .returning({ id: taxCodes.id });
        await this.audit.record(tx, {
          action: 'tax_code.changed',
          entityType: 'tax_codes',
          entityId: added!.id,
          before: {
            periodId: latest.id,
            name: latest.name,
            rateBp: latest.rateBp,
            creditable: latest.creditable,
            effectiveFrom: latest.effectiveFrom,
          },
          after: {
            code: latest.code,
            name: body.name,
            rateBp,
            creditable: body.creditable,
            effectiveFrom: body.effectiveFrom,
          },
        });
        return this.codeSummary(tx, scope.tenantId, code, today);
      });
    } catch (error) {
      if (pgError(error).code === '23P01') {
        throw new ConflictException({
          code: 'conflict',
          message: 'This tax code changed at the same time. Reload the page and try again.',
        });
      }
      throw error;
    }
  }

  /** 200 with the code, closed from `effectiveTo`: from that day it is not offered or priced. */
  async retireTaxCode(code: string, body: RetireTaxCodeBody): Promise<AdminTaxCode> {
    this.caller.assertEditor();
    const today = this.today();
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const periods = await this.periods(tx, scope.tenantId, code, true);
      const plan = planTaxCodeRetire(periods, {
        effectiveTo: body.effectiveTo,
        expectedVersion: body.expectedVersion,
        today,
      });
      if (!plan.ok) throw refused(plan);
      await updateVersioned(tx, taxCodes, plan.close.id, plan.close.version, {
        effectiveTo: plan.close.effectiveTo,
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'tax_code.retired',
        entityType: 'tax_codes',
        entityId: plan.close.id,
        before: { code, effectiveTo: null },
        after: { code, effectiveTo: plan.close.effectiveTo },
      });
      return this.codeSummary(tx, scope.tenantId, code, today);
    });
  }

  /** Every period of one code in this tenant, oldest first; `lock` holds them for the rest of the transaction. */
  private async periods(
    tx: DbTransaction,
    tenantId: string,
    code: string,
    lock = false,
  ): Promise<TaxCodePeriodRow[]> {
    const query = tx
      .select(periodColumns)
      .from(taxCodes)
      .where(and(eq(taxCodes.tenantId, tenantId), eq(taxCodes.code, code)))
      .orderBy(asc(taxCodes.effectiveFrom));
    return lock ? query.for('update') : query;
  }

  private async codeSummary(
    tx: DbTransaction,
    tenantId: string,
    code: string,
    today: string,
  ): Promise<AdminTaxCode> {
    const [summary] = summariseTaxCodes(await this.periods(tx, tenantId, code), today);
    return summary!;
  }

  // --------------------------------------------------------------------------------------- payment terms

  /** Every term, retired ones included, shortest first. */
  async listPaymentTerms(): Promise<AdminPaymentTerm[]> {
    this.caller.assertEditor();
    const { scope } = this.caller.current();
    const rows = await this.db
      .select(termColumns)
      .from(paymentTerms)
      .where(eq(paymentTerms.tenantId, scope.tenantId))
      .orderBy(asc(paymentTerms.netDays), asc(paymentTerms.code));
    return rows.map(toTerm);
  }

  /** 201 with the new term. 409 when its code or name is already used. */
  async createPaymentTerm(body: CreatePaymentTermBody): Promise<AdminPaymentTerm> {
    this.caller.assertEditor();
    const { scope, actor } = this.caller.current();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        await this.assertNameFree(tx, scope.tenantId, body.name);
        const [created] = await tx
          .insert(paymentTerms)
          .values({
            tenantId: scope.tenantId,
            code: body.code,
            name: body.name,
            netDays: body.netDays,
            isActive: true,
          })
          .returning(termColumns);
        await this.audit.record(tx, {
          action: 'payment_term.created',
          entityType: 'payment_terms',
          entityId: created!.id,
          after: { ...body },
        });
        return toTerm(created!);
      });
    } catch (error) {
      const pg = pgError(error);
      if (pg.code === '23505' && pg.constraint === 'payment_terms_tenant_code_unique') {
        throw new ConflictException({
          code: 'conflict',
          message: `The payment term code ${body.code} already exists.`,
        });
      }
      throw error;
    }
  }

  /** 200 with the term. 404 unknown, 409 stale version or a name already used. */
  async updatePaymentTerm(id: string, body: UpdatePaymentTermBody): Promise<AdminPaymentTerm> {
    this.caller.assertEditor();
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const [current] = await tx
        .select(termColumns)
        .from(paymentTerms)
        .where(and(eq(paymentTerms.tenantId, scope.tenantId), eq(paymentTerms.id, id)))
        .for('update');
      if (current === undefined) throw termNotFound();
      const set: Partial<typeof paymentTerms.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) {
        await this.assertNameFree(tx, scope.tenantId, body.name, id);
        set.name = body.name;
      }
      if (body.retired !== undefined) set.isActive = !body.retired;
      const updated = await updateVersioned(tx, paymentTerms, id, body.expectedVersion, set);
      await this.audit.record(tx, {
        action: 'payment_term.updated',
        entityType: 'payment_terms',
        entityId: id,
        before: { name: current.name, retired: !current.isActive },
        after: { name: updated.name, retired: !updated.isActive },
      });
      return toTerm(updated);
    });
  }

  /** Two terms with one name could not be told apart in the pick-list (names compare without case). */
  private async assertNameFree(
    tx: DbTransaction,
    tenantId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const [clash] = await tx
      .select({ id: paymentTerms.id })
      .from(paymentTerms)
      .where(
        and(
          eq(paymentTerms.tenantId, tenantId),
          sql`lower(btrim(${paymentTerms.name})) = lower(btrim(${name}))`,
          exceptId === undefined ? undefined : ne(paymentTerms.id, exceptId),
        ),
      )
      .limit(1);
    if (clash !== undefined) {
      throw new ConflictException({
        code: 'conflict',
        message: `A payment term named "${name}" already exists.`,
      });
    }
  }
}
