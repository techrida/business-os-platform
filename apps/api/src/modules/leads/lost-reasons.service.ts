// LeadLostReasonsService: the tenant's list of lost reasons (D49). A lead stores a reference to an option, so a
// rename shows on every lead and a retired option stays on the leads that carry it. The list is tenant-level: one list
// for every legal entity, like payment terms.
// - Defaults: a tenant has the seven shipped options until it changes the list. Migration 0072 seeds the tenants that
//   exist; a tenant created later is seeded here on first use (seedDefaults, idempotent).
// - Add: anyone who may mark a lead lost can add an option while doing so (changeStage -> choose). The label is
//   trimmed, and "price", "Price " and "PRICE" are one option: a duplicate is refused (409), retired options included,
//   because the database keeps one row per normalised label.
// - Manage: rename, retire and restore, reorder and reset-to-default (D32) are the Founder's (admin.settings.write).
//   Every change is audited by the row trigger, and each action also writes a domain event.
import {
  type CreateLeadLostReasonBody,
  DEFAULT_LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABEL_MAX,
  type LeadLostReason,
  type LeadLostReasonRef,
  LOST_REASONS_STALE_MESSAGE,
  lostReasonsToken,
  type ReorderLeadLostReasonsBody,
  type ResetLeadLostReasonsBody,
  type UpdateLeadLostReasonBody,
} from '@bos/contracts';
import { leadLostReasons } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned } from '../../platform/db/idempotency';
import { type Actor, READ_ONLY, type TxScope, withTx } from '../../platform/db/tx';
import { LeadsCaller } from './leads.caller';

const AUDIT_ENTITY = 'lead_lost_reasons';

type ReasonRow = typeof leadLostReasons.$inferSelect;

/** The trimmed, lower-cased label the database keeps unique per tenant (label_norm). */
export const normalizeReasonLabel = (label: string): string => label.trim().toLowerCase();

/** The same key computed by Postgres, so the table's own check (label_norm = lower(btrim(label))) always accepts it. */
const normSql = (label: string) => sql<string>`lower(btrim(${label}))`;

export const toLostReason = (row: ReasonRow): LeadLostReason => ({
  id: row.id,
  label: row.label,
  position: row.position,
  isDefault: row.defaultKey !== null,
  retired: row.retiredAt !== null,
  version: row.version,
});

/** The reason a lead shows: the option's current label, and whether it has since been retired. */
export async function lostReasonRefs(
  q: Db | DbTransaction,
  tenantId: string,
  ids: Iterable<string | null | undefined>,
): Promise<ReadonlyMap<string, LeadLostReasonRef>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return new Map();
  const rows = await q
    .select()
    .from(leadLostReasons)
    .where(and(eq(leadLostReasons.tenantId, tenantId), inArray(leadLostReasons.id, wanted)));
  return new Map(
    rows.map((r) => [r.id, { id: r.id, label: r.label, retired: r.retiredAt !== null }]),
  );
}

const duplicate = (label: string) =>
  new ConflictException({
    code: 'conflict',
    message: `"${label}" is already on the list of lost reasons`,
  });

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Lost reason not found' });

const staleList = () =>
  new ConflictException({ code: 'conflict', message: LOST_REASONS_STALE_MESSAGE });

const tokenOf = (rows: readonly ReasonRow[]): string =>
  lostReasonsToken(
    rows.map((r) => ({
      id: r.id,
      position: r.position,
      version: r.version,
      retired: r.retiredAt !== null,
    })),
  );

@Injectable()
export class LeadLostReasonsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly caller: LeadsCaller,
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /** The options a caller who may mark a lead lost can pick, in the list's order; retired ones are left out. */
  async choices(): Promise<LeadLostReason[]> {
    const rows = await this.all(false);
    return rows.map(toLostReason);
  }

  /** Every option, retired ones included, for the Founder's Settings card. */
  async listAll(): Promise<LeadLostReason[]> {
    return (await this.all(true)).map(toLostReason);
  }

  private async all(withRetired: boolean): Promise<ReasonRow[]> {
    const { scope, actor } = this.caller.current();
    const existing = await withTx(
      this.db,
      scope,
      actor,
      (tx) => this.ordered(tx, scope.tenantId),
      READ_ONLY,
    );
    // Check the unfiltered list: a tenant that retired every option is already initialized.
    const rows = existing.length > 0 ? existing : await this.bootstrapDefaults(scope, actor);
    return withRetired ? rows : rows.filter((row) => row.retiredAt === null);
  }

  private bootstrapDefaults(scope: TxScope, actor: Actor): Promise<ReasonRow[]> {
    return withTx(this.db, scope, actor, async (tx) => {
      await this.seedDefaults(tx, scope.tenantId);
      return this.ordered(tx, scope.tenantId);
    });
  }

  // ---------------------------------------------------------------------------------------------- manage

  async create(body: CreateLeadLostReasonBody): Promise<LeadLostReason> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      await this.seedDefaults(tx, scope.tenantId);
      const row = await this.insertOption(tx, scope.tenantId, body.label, 'settings');
      return toLostReason(row);
    });
  }

  /** Rename and/or retire or restore one option. 404 unknown, 409 stale version or a label already in use. */
  async update(id: string, body: UpdateLeadLostReasonBody): Promise<LeadLostReason> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      await this.lockTenant(tx, scope.tenantId);
      const [current] = await tx
        .select()
        .from(leadLostReasons)
        .where(and(eq(leadLostReasons.tenantId, scope.tenantId), eq(leadLostReasons.id, id)))
        .for('update');
      if (current === undefined) throw notFound();
      const set: Partial<typeof leadLostReasons.$inferInsert> = { updatedAt: new Date() };
      if (body.label !== undefined) {
        const [clash] = await tx
          .select({ id: leadLostReasons.id })
          .from(leadLostReasons)
          .where(
            and(
              eq(leadLostReasons.tenantId, scope.tenantId),
              eq(leadLostReasons.labelNorm, normSql(body.label.trim())),
              ne(leadLostReasons.id, id),
            ),
          );
        if (clash !== undefined) throw duplicate(body.label.trim());
        set.label = body.label.trim();
        // Postgres computes the key (see normSql); the column's TypeScript type only says string.
        set.labelNorm = normSql(body.label.trim()) as unknown as string;
      }
      if (body.retired !== undefined) {
        set.retiredAt = body.retired ? (current.retiredAt ?? new Date()) : null;
      }
      const updated = await updateVersioned(tx, leadLostReasons, id, body.expectedVersion, set);
      await this.audit.record(tx, {
        action: 'lead_lost_reason.updated',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { label: current.label, retired: current.retiredAt !== null },
        after: { label: updated.label, retired: updated.retiredAt !== null },
      });
      return toLostReason(updated);
    });
  }

  /** `ids` must name every option of the tenant exactly once, retired ones included. */
  async reorder(body: ReorderLeadLostReasonsBody): Promise<LeadLostReason[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      await this.lockTenant(tx, scope.tenantId);
      await this.seedDefaults(tx, scope.tenantId);
      const rows = await tx
        .select()
        .from(leadLostReasons)
        .where(eq(leadLostReasons.tenantId, scope.tenantId))
        .for('update');
      // Stale-view guard (D54-4): checked before the id list so an outdated screen sees 409, not 400.
      if (tokenOf(rows) !== body.expectedOrder) throw staleList();
      const known = new Set(rows.map((r) => r.id));
      const sent = new Set(body.ids);
      if (
        sent.size !== body.ids.length ||
        sent.size !== known.size ||
        body.ids.some((i) => !known.has(i))
      ) {
        throw new BadRequestException({
          code: 'bad_request',
          message: 'The new order must list every lost reason exactly once',
        });
      }
      const before = [...rows].sort((a, b) => a.position - b.position).map((r) => r.id);
      for (const [position, id] of body.ids.entries()) {
        const row = rows.find((r) => r.id === id)!;
        if (row.position === position) continue;
        await tx
          .update(leadLostReasons)
          .set({ position, updatedAt: new Date(), version: sql`${leadLostReasons.version} + 1` })
          .where(and(eq(leadLostReasons.tenantId, scope.tenantId), eq(leadLostReasons.id, id)));
      }
      await this.audit.record(tx, {
        action: 'lead_lost_reasons.reordered',
        entityType: AUDIT_ENTITY,
        entityId: scope.tenantId,
        before: { order: before },
        after: { order: body.ids },
      });
      return (await this.ordered(tx, scope.tenantId)).map(toLostReason);
    });
  }

  /**
   * Back to the defaults (D32): the seven shipped options get their labels, order and active state back; an option
   * the tenant added is retired and listed after them (leads keep it), and renamed "<label> (custom)" when its words
   * are now a default's. Nothing is deleted, so no lead loses its reason.
   */
  async reset(body: ResetLeadLostReasonsBody): Promise<LeadLostReason[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      await this.lockTenant(tx, scope.tenantId);
      await this.seedDefaults(tx, scope.tenantId);
      const rows = await tx
        .select()
        .from(leadLostReasons)
        .where(eq(leadLostReasons.tenantId, scope.tenantId))
        .orderBy(asc(leadLostReasons.position), asc(leadLostReasons.label))
        .for('update');
      if (tokenOf(rows) !== body.expectedOrder) throw staleList();
      const defaultNorms = new Set(
        DEFAULT_LEAD_LOST_REASONS.map((d) => normalizeReasonLabel(d.label)),
      );
      const target = new Map<string, { label: string; position: number; retired: boolean }>();
      DEFAULT_LEAD_LOST_REASONS.forEach((d, position) => {
        const row = rows.find((r) => r.defaultKey === d.key);
        if (row !== undefined) target.set(row.id, { label: d.label, position, retired: false });
      });
      let next = DEFAULT_LEAD_LOST_REASONS.length;
      const customs = rows.filter((r) => r.defaultKey === null);
      // Every final label must stay unique and within the limit: a colliding custom option gets a free
      // "(custom)" or "(custom 2)" suffix, never a label another option already holds or ends up with.
      const taken = new Set([
        ...defaultNorms,
        ...customs.filter((r) => !defaultNorms.has(r.labelNorm)).map((r) => r.labelNorm),
      ]);
      for (const row of customs) {
        let label = row.label;
        if (defaultNorms.has(row.labelNorm)) {
          for (let n = 1; ; n += 1) {
            const suffix = n === 1 ? ' (custom)' : ` (custom ${n})`;
            label = `${row.label.slice(0, LEAD_LOST_REASON_LABEL_MAX - suffix.length)}${suffix}`;
            if (!taken.has(normalizeReasonLabel(label))) break;
          }
          taken.add(normalizeReasonLabel(label));
        }
        target.set(row.id, { label, position: next++, retired: true });
      }
      const changed = rows.filter((r) => {
        const t = target.get(r.id);
        return (
          t !== undefined &&
          (t.label !== r.label || t.position !== r.position || t.retired !== (r.retiredAt !== null))
        );
      });
      // Two phases: labels are unique per tenant, so two options swapping words must pass through a free label.
      for (const row of changed.filter((r) => r.label !== target.get(r.id)!.label)) {
        await tx
          .update(leadLostReasons)
          .set({ label: row.id, labelNorm: row.id.toLowerCase() })
          .where(and(eq(leadLostReasons.tenantId, scope.tenantId), eq(leadLostReasons.id, row.id)));
      }
      for (const row of changed) {
        const t = target.get(row.id)!;
        await tx
          .update(leadLostReasons)
          .set({
            label: t.label,
            labelNorm: normSql(t.label),
            position: t.position,
            retiredAt: t.retired ? (row.retiredAt ?? new Date()) : null,
            updatedAt: new Date(),
            version: sql`${leadLostReasons.version} + 1`,
          })
          .where(and(eq(leadLostReasons.tenantId, scope.tenantId), eq(leadLostReasons.id, row.id)));
      }
      await this.audit.record(tx, {
        action: 'lead_lost_reasons.reset',
        entityType: AUDIT_ENTITY,
        entityId: scope.tenantId,
        meta: { changed: changed.map((r) => r.id) },
      });
      return (await this.ordered(tx, scope.tenantId)).map(toLostReason);
    });
  }

  // ------------------------------------------------------------------------------------- marking a lead lost

  /**
   * The option a lead is marked lost with, inside the stage change's transaction: an existing option by id (400 when it
   * is unknown or retired), or a new one added now from `newLostReason` (409 when its words are already an option).
   */
  async choose(
    tx: DbTransaction,
    tenantId: string,
    pick: { lostReasonId?: string | undefined; newLostReason?: string | undefined },
  ): Promise<{ id: string; label: string }> {
    await this.seedDefaults(tx, tenantId);
    if (pick.lostReasonId !== undefined) {
      // FOR SHARE: update() and reset() change a row under FOR UPDATE, so a retire that commits first is read here as
      // retired (the 400 below), and one that arrives later waits until this stage change commits. Without the lock a
      // lead or deal could be saved Lost with an option retired in between.
      const [row] = await tx
        .select()
        .from(leadLostReasons)
        .where(
          and(eq(leadLostReasons.tenantId, tenantId), eq(leadLostReasons.id, pick.lostReasonId)),
        )
        .for('share');
      if (row === undefined) {
        throw new BadRequestException({ code: 'bad_request', message: 'Unknown lost reason' });
      }
      if (row.retiredAt !== null) {
        throw new BadRequestException({
          code: 'bad_request',
          message: `"${row.label}" is no longer offered as a lost reason`,
        });
      }
      return { id: row.id, label: row.label };
    }
    const typed = (pick.newLostReason ?? '').trim();
    if (typed === '' || typed.length > LEAD_LOST_REASON_LABEL_MAX) {
      throw new BadRequestException({
        code: 'bad_request',
        message: `Choose a lost reason, or add one of 1 to ${LEAD_LOST_REASON_LABEL_MAX} characters`,
      });
    }
    const row = await this.insertOption(tx, tenantId, typed, 'mark_lost');
    return { id: row.id, label: row.label };
  }

  // --------------------------------------------------------------------------------------------- internals

  /**
   * One writer per tenant at a time for this list: two adds never share a position, two renames to the same words
   * answer 409 instead of a unique-index error, and reorder, reset and update never wait on each other's row locks.
   */
  private async lockTenant(tx: DbTransaction, tenantId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`lead_lost_reasons:${tenantId}`}))`,
    );
  }

  /** Adds an option at the end of the list; 409 when its normalised label is taken (active or retired). */
  private async insertOption(
    tx: DbTransaction,
    tenantId: string,
    rawLabel: string,
    via: 'settings' | 'mark_lost',
  ): Promise<ReasonRow> {
    const label = rawLabel.trim();
    await this.lockTenant(tx, tenantId);
    const [last] = await tx
      .select({ position: sql<number>`coalesce(max(${leadLostReasons.position}), -1)::int` })
      .from(leadLostReasons)
      .where(eq(leadLostReasons.tenantId, tenantId));
    const [row] = await tx
      .insert(leadLostReasons)
      .values({
        tenantId,
        label,
        labelNorm: normSql(label),
        position: (last?.position ?? -1) + 1,
      })
      .onConflictDoNothing()
      .returning();
    if (row === undefined) throw duplicate(label);
    await this.audit.record(tx, {
      action: 'lead_lost_reason.created',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      after: { label: row.label },
      meta: { via },
    });
    return row;
  }

  private ordered(tx: DbTransaction, tenantId: string): Promise<ReasonRow[]> {
    return tx
      .select()
      .from(leadLostReasons)
      .where(eq(leadLostReasons.tenantId, tenantId))
      .orderBy(asc(leadLostReasons.position), asc(leadLostReasons.label));
  }

  /** Gives a tenant that has no options yet the seven defaults. Safe to repeat and to race (ON CONFLICT DO NOTHING). */
  private async seedDefaults(tx: DbTransaction, tenantId: string): Promise<void> {
    const [any] = await tx
      .select({ id: leadLostReasons.id })
      .from(leadLostReasons)
      .where(eq(leadLostReasons.tenantId, tenantId))
      .limit(1);
    if (any !== undefined) return;
    await tx
      .insert(leadLostReasons)
      .values(
        DEFAULT_LEAD_LOST_REASONS.map((d, position) => ({
          tenantId,
          label: d.label,
          labelNorm: normalizeReasonLabel(d.label),
          position,
          defaultKey: d.key,
        })),
      )
      .onConflictDoNothing();
  }
}
