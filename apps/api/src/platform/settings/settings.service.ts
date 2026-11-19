// Versioned settings. Serves the NFR "configuration changes are versioned and audited": a change never edits
// a row, it appends the next version of the key, so "what was the VAT rate on 3 June" always has an answer.
//
// Reads take a TxScope (the worker has no request); writes take the caller's transaction, which withTx has
// already stamped with tenant, organization and actor. A setting nobody has written yet falls back to a
// default kept here, because most SETTINGS schemas have no default of their own (they only validate).
import { SETTING_DEFAULTS, SETTINGS, type SettingKey, type SettingValue } from '@bos/contracts';
import { numberSeries } from '@bos/db';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';

/** What a key reads as before anyone has written it: one source, in contracts, shared with the workspace's reset. */
export { SETTING_DEFAULTS };

export interface SettingVersion {
  version: number;
  value: unknown;
  /** `app.users.id` of the editor, or null when a system job wrote it. */
  createdBy: string | null;
  createdAt: Date;
}

/** Optional guard for `set()`: the version the editor loaded. `null` means they loaded the default (nothing saved). */
export interface SetOptions {
  expectedVersion?: number | null;
}

export interface TxContext {
  tenantId: string;
  organizationId: string;
  /** The acting `app.users.id`, or null when the actor is not a user (a job, the seed, ZITADEL). */
  userId: string | null;
}

/** The advisory-lock text for one (tenant, entity, key): the same string for every writer of that key. */
export function settingLockKey(tenantId: string, organizationId: string, key: SettingKey): string {
  return `${tenantId}:${organizationId}:${key}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the scope and actor that withTx stamped on the transaction. Throws when the scope is empty, which
 * means the transaction was not opened with withTx (unset gives NULL, a value reverted at COMMIT gives '').
 * `created_by` columns have no foreign key and hold a user id only: a system actor id such as
 * `system:seed` is not a uuid and must become NULL instead of failing the insert.
 */
export async function readTxContext(tx: DbTransaction, caller: string): Promise<TxContext> {
  const result = await tx.execute<{
    tenant_id: string | null;
    organization_id: string | null;
    actor_kind: string | null;
    actor_id: string | null;
  }>(
    sql`SELECT current_setting('bos.tenant_id', true) AS tenant_id,
               current_setting('bos.organization_id', true) AS organization_id,
               current_setting('bos.actor_kind', true) AS actor_kind,
               current_setting('bos.actor_id', true) AS actor_id`,
  );
  const row = result.rows[0];
  if (!row?.tenant_id || !row.organization_id) {
    throw new Error(
      `${caller} needs a transaction opened with withTx: bos.tenant_id and bos.organization_id are not set`,
    );
  }
  const userId =
    row.actor_kind === 'user' && row.actor_id && UUID.test(row.actor_id) ? row.actor_id : null;
  return { tenantId: row.tenant_id, organizationId: row.organization_id, userId };
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The latest version of `key` with its number, or the default with `version: null`. */
  async getCurrent<K extends SettingKey>(
    scope: TxScope,
    key: K,
  ): Promise<{ value: SettingValue<K>; version: number | null }> {
    // Raw SQL, not drizzle's jsonb column: node-postgres already parses jsonb, and drizzle then runs
    // JSON.parse on any string result, so the stored string "10" would come back as the number 10.
    const result = await this.db.execute<{ version: number; value: unknown }>(sql`
      SELECT version, value FROM app.settings
       WHERE tenant_id = ${scope.tenantId}::uuid AND organization_id = ${scope.organizationId}::uuid
         AND key = ${key}::text
       ORDER BY version DESC LIMIT 1`);
    const row = result.rows[0];
    if (row) return { value: row.value as SettingValue<K>, version: Number(row.version) };
    // A copy, so a caller that mutates the result cannot change the default for everyone.
    return { value: structuredClone(SETTING_DEFAULTS[key]), version: null };
  }

  /**
   * Takes the same per-key advisory lock `set()` takes, inside the caller's transaction. A read-modify-write
   * (read the list, change one entry, `set` the list) must call this BEFORE its read: `set()` alone locks
   * only at the write, so two writers could both read version 3 and the second would silently drop the
   * first's change. The lock is re-entrant within a transaction, so the later `set()` takes it again at no cost.
   */
  async lock(tx: DbTransaction, key: SettingKey): Promise<void> {
    const context = await readTxContext(tx, 'SettingsService.lock');
    await this.lockWith(tx, context, key);
  }

  /**
   * Locks `key` (see `lock`) and then reads its latest version on `tx`, so the read sees whatever the
   * previous holder committed. The default applies when nobody has written the key yet.
   * Needs READ COMMITTED (the default): each statement then takes a fresh snapshot after the lock is won.
   */
  async getLocked<K extends SettingKey>(
    tx: DbTransaction,
    key: K,
  ): Promise<{ value: SettingValue<K>; version: number | null }> {
    const context = await readTxContext(tx, 'SettingsService.getLocked');
    await this.lockWith(tx, context, key);
    const result = await tx.execute<{ version: number; value: unknown }>(sql`
      SELECT version, value FROM app.settings
       WHERE tenant_id = ${context.tenantId}::uuid AND organization_id = ${context.organizationId}::uuid
         AND key = ${key}::text
       ORDER BY version DESC LIMIT 1`);
    const row = result.rows[0];
    if (row) return { value: row.value as SettingValue<K>, version: Number(row.version) };
    return { value: structuredClone(SETTING_DEFAULTS[key]), version: null };
  }

  private async lockWith(tx: DbTransaction, context: TxContext, key: SettingKey): Promise<void> {
    const lockText = settingLockKey(context.tenantId, context.organizationId, key);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockText}::text, 0))`);
  }

  /** The value in force for `key`: the latest version, or the default when none was ever written. */
  async get<K extends SettingKey>(scope: TxScope, key: K): Promise<SettingValue<K>> {
    return (await this.getCurrent(scope, key)).value;
  }

  /**
   * Appends the next version of `key` inside the caller's transaction and returns its number.
   *
   * Two admins saving at once would both read max(version) = 3 and both try version 4; the loser would hit
   * the unique constraint and, in Postgres, a unique violation aborts the whole transaction. An advisory
   * lock keyed on (tenant, organization, key) makes the second caller wait until the first commits, then
   * read max(version) = 4 and take 5. The lock is per transaction, so COMMIT or ROLLBACK frees it.
   *
   * `options.expectedVersion` stops a save from overwriting a concurrent edit: the editor passes the version it
   * loaded (null for "nothing saved yet"), and once the lock is won the saved version is read again. Any
   * difference refuses with 409 `stale_setting` and writes nothing. Left out, the write is unconditional.
   */
  async set(
    tx: DbTransaction,
    key: SettingKey,
    value: unknown,
    options: SetOptions = {},
  ): Promise<{ version: number }> {
    const schema: z.ZodType = SETTINGS[key];
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestException(`Invalid value for ${key}: ${issues}`);
    }

    const { tenantId, organizationId, userId } = await readTxContext(tx, 'SettingsService.set');

    await this.lockWith(tx, { tenantId, organizationId, userId }, key);

    if (options.expectedVersion !== undefined) {
      // Read after the lock: a writer that queued behind us sees what the winner committed (READ COMMITTED).
      const current = await tx.execute<{ version: number }>(sql`
        SELECT version FROM app.settings
         WHERE tenant_id = ${tenantId}::uuid AND organization_id = ${organizationId}::uuid
           AND key = ${key}::text
         ORDER BY version DESC LIMIT 1`);
      const currentRow = current.rows[0];
      const currentVersion = currentRow ? Number(currentRow.version) : null;
      if (currentVersion !== options.expectedVersion) {
        throw new ConflictException({
          code: 'stale_setting',
          message: 'This setting was changed by someone else. Reload to see the current value.',
        });
      }
    }

    // The parsed value, not the raw one: a schema may fill in defaults, and the stored row should be complete.
    const result = await tx.execute<{ version: number }>(sql`
      INSERT INTO app.settings (tenant_id, organization_id, key, version, value, created_by)
      SELECT ${tenantId}::uuid, ${organizationId}::uuid, ${key}::text,
             coalesce(max(version), 0) + 1, ${JSON.stringify(parsed.data)}::jsonb, ${userId}::uuid
        FROM app.settings
       WHERE tenant_id = ${tenantId}::uuid AND organization_id = ${organizationId}::uuid AND key = ${key}::text
      RETURNING version`);
    const row = result.rows[0];
    if (!row) throw new Error(`setting ${key}: insert returned no row`);
    return { version: Number(row.version) };
  }

  /** Every version of `key`, newest first. */
  async history(scope: TxScope, key: SettingKey): Promise<SettingVersion[]> {
    // Raw SQL for the same jsonb reason as getCurrent. drizzle's execute() also hands timestamps back as
    // text, so created_at is formatted as ISO-8601 UTC here and turned into a Date below.
    const result = await this.db.execute<{
      version: number;
      value: unknown;
      created_by: string | null;
      created_at: string;
    }>(sql`
      SELECT version, value, created_by, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at FROM app.settings
       WHERE tenant_id = ${scope.tenantId}::uuid AND organization_id = ${scope.organizationId}::uuid
         AND key = ${key}::text
       ORDER BY version DESC`);
    return result.rows.map((r) => ({
      version: Number(r.version),
      value: r.value,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
    }));
  }

  /** The counter rows of every number series, for the admin screen (read-only: NumberingService owns them). */
  async listNumberSeries(scope: TxScope) {
    return this.db
      .select({
        key: numberSeries.key,
        fiscalYear: numberSeries.fiscalYear,
        prefix: numberSeries.prefix,
        nextValue: numberSeries.nextValue,
        pad: numberSeries.pad,
      })
      .from(numberSeries)
      .where(
        and(
          eq(numberSeries.tenantId, scope.tenantId),
          eq(numberSeries.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(numberSeries.key), desc(numberSeries.fiscalYear));
  }
}
