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
  /** `asc` (the default) pages forward from `afterId`; `desc` returns the newest `limit` events, newest first. */
  order?: 'asc' | 'desc' | undefined;
  /** Read the whole tenant, not only the caller's entity (the audit rows of other entities are then included). */
  tenantWide?: boolean | undefined;
}

/** audit.read_events returns at most this many rows per call. */
const READ_EVENTS_MAX = 500;

/**
 * How many id-only pages a newest-first read may walk before it refuses (200 x 500: 100,000 or more
 * matching events). A larger result needs a narrower filter (`from`, `entityId`) instead of an ever longer scan.
 */
export const NEWEST_FIRST_MAX_PAGES = 200;

/** Too many matching events to find the newest ones within NEWEST_FIRST_MAX_PAGES. */
export class AuditNewestFirstTooLargeError extends Error {
  constructor() {
    super(
      `${NEWEST_FIRST_MAX_PAGES * READ_EVENTS_MAX} or more audit events match; narrow the list with from or entityId.`,
    );
    this.name = 'AuditNewestFirstTooLargeError';
  }
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
  before_text: string | null;
  after_text: string | null;
  meta_text: string | null;
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
  /** Absent from rows until verify_chain has a `reason` column (migration 0008). */
  reason?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /**
   * Events of the caller's tenant and organization in id order, optionally filtered. `order: 'desc'`
   * returns the newest `limit` events instead, newest first (see `listNewestFirst`).
   */
  async list(scope: TxScope, q: AuditListQuery): Promise<AuditEventDto[]> {
    if (q.order === 'desc') return this.listNewestFirst(scope, q);
    return this.readPage(scope, q);
  }

  /**
   * The newest `limit` events, newest first. audit.read_events only pages forward by id and bos_app has no
   * right on audit.audit_events, so the end cannot be read directly: this walks the matching ids forward
   * (ids only, 500 per call), keeps the last `limit + 1`, then reads the full rows of the tail in one more
   * call and reverses them. Ids are compared by position only, never as numbers.
   *
   * Cost grows with the number of matching events (one round trip per 500), so the walk stops at
   * NEWEST_FIRST_MAX_PAGES and refuses rather than return the tail of a truncated scan. Events appended
   * after the walk has passed are not included.
   */
  private async listNewestFirst(scope: TxScope, q: AuditListQuery): Promise<AuditEventDto[]> {
    const keep = q.limit + 1;
    let tail: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page === NEWEST_FIRST_MAX_PAGES) throw new AuditNewestFirstTooLargeError();
      // Annotated: `cursor` feeds this query and is set from its rows, which TypeScript cannot infer.
      const result: { rows: { id: string }[] } = await this.db.execute<{ id: string }>(sql`
        SELECT id
          FROM audit.read_events(
            ${scope.tenantId}::uuid, ${q.tenantWide ? null : scope.organizationId}::uuid,
            ${q.entityType ?? null}::text, ${q.entityId ?? null}::text,
            ${q.from?.toISOString() ?? null}::timestamptz, ${q.to?.toISOString() ?? null}::timestamptz,
            ${cursor}::bigint, ${READ_EVENTS_MAX}::integer)`);
      const ids = result.rows.map((row) => String(row.id));
      tail = [...tail, ...ids].slice(-keep);
      const last = ids.at(-1);
      if (ids.length < READ_EVENTS_MAX || last === undefined) break;
      cursor = last;
    }
    // With limit + 1 ids in hand, the first one is the cursor and the rest are exactly the newest `limit`.
    const afterId = tail.length === keep ? tail[0] : undefined;
    const events = await this.readPage(scope, { ...q, afterId, limit: q.limit });
    return events.reverse();
  }

  /** One forward page of audit.read_events, with the actors' display names. */
  private async readPage(scope: TxScope, q: AuditListQuery): Promise<AuditEventDto[]> {
    // Why to_char/host instead of the driver's own conversion: node-postgres turns timestamptz into a JS
    // Date (milliseconds) and date into a Date at local midnight, but the stored hash covers microseconds
    // and a date without a time zone. Formatting in SQL keeps the exposed values equal to what was hashed,
    // so an outside verifier can recompute them.
    //
    // The jsonb columns come twice: parsed (before/after/meta, for display) and as Postgres's own ::text
    // (*_text, returned as `canonical`). The hash covers the ::text form, which sorts keys and keeps numbers
    // like 1.50; parsing in node and re-serialising loses both, so only the text can be hashed again.
    const result = await this.db.execute<AuditRow>(sql`
      SELECT id, tenant_id, organization_id,
             to_char(chain_month, 'YYYY-MM-DD') AS chain_month,
             seq,
             to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
             actor_kind, actor_id, action, entity_type, entity_id, before, after, meta,
             before::text AS before_text, after::text AS after_text, meta::text AS meta_text,
             host(ip) AS ip, user_agent, correlation_id, prev_hash, hash
        FROM audit.read_events(
          ${scope.tenantId}::uuid, ${q.tenantWide ? null : scope.organizationId}::uuid,
          ${q.entityType ?? null}::text, ${q.entityId ?? null}::text,
          ${q.from?.toISOString() ?? null}::timestamptz, ${q.to?.toISOString() ?? null}::timestamptz,
          ${q.afterId ?? null}::bigint, ${q.limit}::integer)`);
    const events = result.rows.map(toDto);
    const names = await this.displayNames(
      scope,
      events.flatMap((e) => (e.actorKind === 'user' ? [e.actorId] : [])),
    );
    return events.map((e) => ({
      ...e,
      actorDisplayName:
        e.actorKind === 'user' ? (names.get(e.actorId.toLowerCase()) ?? null) : null,
    }));
  }

  /**
   * Display names for the people behind a page of events, in one query. Only the name is read, never the
   * address, and only users of the caller's tenant (users are tenant-scoped, ADR 0027): an actor id that
   * belongs to another tenant, was never a user, or is not a uuid (`system:<job>`) simply has no entry.
   * This is read-side decoration; the stored events and the hash chain are untouched.
   */
  private async displayNames(
    scope: TxScope,
    actorIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(actorIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const result = await this.db.execute<{ id: string; display_name: string | null }>(sql`
      SELECT id, display_name FROM app.users
       WHERE tenant_id = ${scope.tenantId}::uuid
         AND id IN (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`);
    for (const row of result.rows) {
      const name = row.display_name?.trim();
      if (name) names.set(row.id.toLowerCase(), name);
    }
    return names;
  }

  /**
   * Recomputes the hash chain of one UTC month for one tenant. `month` is 'YYYY-MM'; the caller has
   * validated it. pg returns the two bigint columns as strings, so they become numbers here (a month's row
   * count and sequence numbers stay far below 2^53).
   */
  async verifyChain(tenantId: string, month: string): Promise<ChainVerifyDto> {
    // `reason` (why the chain failed) is read through to_jsonb(v) instead of by column name: that gives the
    // value once verify_chain returns it and NULL before, so this query does not depend on migration order.
    const result = await this.db.execute<VerifyRow>(
      sql`SELECT v.ok, v."rows", v.first_bad_seq, to_jsonb(v)->>'reason' AS reason
            FROM audit.verify_chain(${tenantId}::uuid, ${`${month}-01`}::date) v`,
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
      reason: row.reason ?? null,
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
    canonical: { before: r.before_text, after: r.after_text, meta: r.meta_text },
    ip: r.ip,
    userAgent: r.user_agent,
    correlationId: r.correlation_id,
    prevHash: r.prev_hash.toString('hex'),
    hash: r.hash.toString('hex'),
  };
}
