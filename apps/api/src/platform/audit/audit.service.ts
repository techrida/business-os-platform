// The audit trail's application side. Serves the NFR "every change is audited, and the trail is
// tamper-evident" (ADR 0020).
//
// bos_app has no table right on audit.audit_events, so everything here goes through three SQL functions:
//   * audit.record()        appends a domain event inside the caller's withTx transaction;
//   * audit.read_events()   lists events (SECURITY DEFINER, filtered by the tenant we pass in);
//   * audit.verify_chain()  recomputes one month's hash chain.
// The two readers take their scope as arguments and need no bos.* settings, so reads run on the plain pool
// and work in the worker too (no request, no ctx()).
import { type AuditEventDto, type ChainVerifyDto, ChainVerifyDtoSchema } from '@bos/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';

export interface AuditRecordInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

export interface AuditListQuery {
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  /** The last event id the caller has seen (a bigint as a string); the page starts after it. */
  afterId?: string | undefined;
  limit: number;
}

/**
 * One row of audit.read_events as node-postgres returns it. Columns are picked explicitly in the query so
 * that dates and addresses arrive as the text we want (see `list`); bigints are strings, bytea is a Buffer.
 * A `type` alias, not an interface: drizzle's execute() wants a Record<string, unknown>, and only aliases
 * get the implicit index signature.
 */
type AuditRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  chain_month: string;
  seq: string;
  occurred_at: string;
  actor_kind: AuditEventDto['actorKind'];
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  meta: unknown;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string;
  prev_hash: Buffer;
  hash: Buffer;
};

type VerifyRow = {
  ok: boolean;
  rows: string;
  first_bad_seq: string | null;
};

/** `undefined` and `null` both mean "no value" (SQL NULL); anything else is sent as JSON text. */
function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Appends a domain event (one that is not a row change, e.g. `approval.approved`) to the caller's
   * transaction. Tenant, organization and actor come from the bos.* settings that withTx stamped, so a
   * transaction opened any other way makes audit.record() raise instead of writing an unattributed row.
   */
  async record(tx: DbTransaction, e: AuditRecordInput): Promise<void> {
    await tx.execute(
      sql`SELECT audit.record(${e.action}, ${e.entityType}, ${e.entityId},
        ${jsonOrNull(e.before)}::jsonb, ${jsonOrNull(e.after)}::jsonb, ${jsonOrNull(e.meta)}::jsonb)`,
    );
  }

  /** Events of the caller's tenant and organization in id order, optionally filtered. */
  async list(scope: TxScope, q: AuditListQuery): Promise<AuditEventDto[]> {
    // Why to_char/host instead of the driver's own conversion: node-postgres turns timestamptz into a JS
    // Date (milliseconds) and date into a Date at local midnight, but the stored hash covers microseconds
    // and a date without a time zone. Formatting in SQL keeps the exposed values equal to what was hashed,
    // so an outside verifier can recompute them.
    const result = await this.db.execute<AuditRow>(sql`
      SELECT id, tenant_id, organization_id,
             to_char(chain_month, 'YYYY-MM-DD') AS chain_month,
             seq,
             to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
             actor_kind, actor_id, action, entity_type, entity_id, before, after, meta,
             host(ip) AS ip, user_agent, correlation_id, prev_hash, hash
        FROM audit.read_events(
          ${scope.tenantId}::uuid, ${scope.organizationId}::uuid,
          ${q.entityType ?? null}::text, ${q.entityId ?? null}::text,
          ${q.from?.toISOString() ?? null}::timestamptz, ${q.to?.toISOString() ?? null}::timestamptz,
          ${q.afterId ?? null}::bigint, ${q.limit}::integer)`);
    return result.rows.map(toDto);
  }

  /**
   * Recomputes the hash chain of one UTC month for one tenant. `month` is 'YYYY-MM'; the caller has
   * validated it. pg returns the two bigint columns as strings, so they become numbers here (a month's row
   * count and sequence numbers stay far below 2^53).
   */
  async verifyChain(tenantId: string, month: string): Promise<ChainVerifyDto> {
    const result = await this.db.execute<VerifyRow>(
      sql`SELECT ok, "rows", first_bad_seq
            FROM audit.verify_chain(${tenantId}::uuid, ${`${month}-01`}::date)`,
    );
    // verify_chain always returns exactly one row, even for a month with no events (ok, 0 rows).
    const row = result.rows[0];
    if (!row) throw new Error('audit.verify_chain returned no row');
    return ChainVerifyDtoSchema.parse({
      tenantId,
      month,
      ok: row.ok,
      rows: Number(row.rows),
      firstBadSeq: row.first_bad_seq === null ? null : Number(row.first_bad_seq),
    });
  }
}

function toDto(r: AuditRow): AuditEventDto {
  return {
    id: String(r.id),
    tenantId: r.tenant_id,
    organizationId: r.organization_id,
    chainMonth: r.chain_month,
    seq: Number(r.seq),
    occurredAt: r.occurred_at,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    meta: r.meta,
    ip: r.ip,
    userAgent: r.user_agent,
    correlationId: r.correlation_id,
    prevHash: r.prev_hash.toString('hex'),
    hash: r.hash.toString('hex'),
  };
}
