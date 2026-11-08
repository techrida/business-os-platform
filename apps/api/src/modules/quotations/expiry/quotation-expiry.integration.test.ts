// The quotation expiry job against real Postgres (P2 unit Q3c). The real store, the real AuditService and the
// real NotifyService (bell only, so its directory, config and queue are never touched), the real migrations
// with the quotation freeze triggers, under the job's own actor.
//
// What it holds:
//   * a sent version, and an approved one, past valid_until become expired in every tenant, with expired_at, a
//     bumped row version, one status history row (from the old status, no user), one audit event and one bell
//     notice for the quotation's owner;
//   * a version valid today, or later, is not touched;
//   * a second run changes nothing more: no new history, audit or notice row, and the version row stays as it was;
//   * an accepted version past valid_until is never touched;
//   * an expiry racing an accept leaves exactly one outcome: with the accept uncommitted the job waits on the row
//     lock, then skips the accepted version; with the expiry committed first the accept's conditional update
//     matches nothing.
//
// The sweep reads every tenant of the shared container, so the tests assert on their own version ids, never on
// the sweep's global totals.
//
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/expiry/quotation-expiry.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { createParty, createStaffUser, createTenantWithEntity, runMigrations } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { CoreConfig } from '../../../platform/config/config';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import {
  drizzleExpiryStore,
  QuotationExpirySweeper,
  type RunInTx,
} from './quotation-expiry.sweeper';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const ADDRESS = { line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' };

/** 12:00 on 2026-11-09 in Kathmandu. */
const NOW = new Date('2026-11-09T06:15:00.000Z');
const YESTERDAY = '2026-11-08';
const TODAY = '2026-11-09';
const NEXT_WEEK = '2026-11-16';

interface TestScope extends TxScope {
  customerId: string;
  ownerUserId: string;
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let audit: AuditService;
let sweeper: QuotationExpirySweeper;

const runTx: RunInTx = (scope, actor, fn) => withTx(db, scope, actor, fn);
const seedActor = () => systemActor('quotation-expiry-test-seed');

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  pool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: pool });
  audit = new AuditService(db);
  // Bell notices only: the service never reads its config, directory or queue on that path.
  const notify = new NotifyService(
    db,
    {} as CoreConfig,
    {} as unknown as UserDirectory,
    {} as Queue,
  );
  sweeper = new QuotationExpirySweeper(drizzleExpiryStore(db), runTx, audit, notify, () => NOW);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// ---------------------------------------------------------------------------------------- helpers

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

/** A tenant with its default entity, a customer and a staff user who owns the quotations. */
async function newScope(): Promise<TestScope> {
  const tenant = await createTenantWithEntity(pool);
  const scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const { partyId } = await createParty(pool, { tenantId: tenant.tenantId, kind: 'customer' });
  const { userId } = await createStaffUser(pool, { ...tenant });
  await withTx(db, scope, seedActor(), (tx) =>
    tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
      VALUES (${partyId}::uuid, ${tenant.tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              'Himal Traders Pvt. Ltd.', 'himal traders', ${JSON.stringify(ADDRESS)}::jsonb)`),
  );
  return { ...scope, customerId: partyId, ownerUserId: userId };
}

interface Seeded {
  versionId: string;
  quotationId: string;
  number: string;
}

/** One quotation with one version, moved to `status` the way the app does (valid_until is fixed at insert). */
async function seedVersion(
  scope: TestScope,
  options: { status: 'approved' | 'sent'; validUntil: string; owner?: boolean },
): Promise<Seeded> {
  const { tenantId, organizationId } = scope;
  const number = `QT-${randomUUID().slice(0, 8)}`;
  const owner = options.owner === false ? null : scope.ownerUserId;
  return withTx(db, scope, seedActor(), async (tx) => {
    const opp = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${`DEAL-${randomUUID().slice(0, 8)}`},
              'Himal solar', ${scope.customerId}::uuid) RETURNING id`);
    const quotation = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.quotations
        (tenant_id, organization_id, number, customer_party_id, opportunity_id, owner_user_id)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${number}, ${scope.customerId}::uuid,
              ${first(opp.rows).id}::uuid, ${owner}::uuid) RETURNING id`);
    const quotationId = first(quotation.rows).id;
    const version = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.quotation_versions
        (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until, scope,
         payment_schedule, subtotal, discount_amount, taxable_amount, tax_amount, total)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${quotationId}::uuid, 1, 'NPR',
              '2026-10-01', ${options.validUntil}::date, 'Supply and install 12 panels',
              ${JSON.stringify([{ label: 'Advance', percent: '100' }])}::jsonb,
              1000, 0, 1000, 130, 1130) RETURNING id`);
    const versionId = first(version.rows).id;
    // Submit writes the frozen snapshot; approve and send only move the status.
    await tx.execute(sql`
      UPDATE app.quotation_versions
         SET status = 'submitted', submitted_at = now(), fx_rate = 1, amount_npr = total,
             npr_taxable_amount = taxable_amount, content_sha256 = decode(repeat('ab', 32), 'hex'),
             snapshot_sha256 = decode(repeat('ab', 32), 'hex')
       WHERE id = ${versionId}::uuid`);
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now() WHERE id = ${versionId}::uuid`,
    );
    if (options.status === 'sent') {
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now() WHERE id = ${versionId}::uuid`,
      );
    }
    return { versionId, quotationId, number };
  });
}

async function versionRow(versionId: string) {
  const { rows } = await pool.query<{
    status: string;
    version: number;
    expired_at: Date | null;
    accepted_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT status, version, expired_at, accepted_at, updated_at
       FROM app.quotation_versions WHERE id = $1`,
    [versionId],
  );
  return first(rows);
}

async function historyRows(versionId: string) {
  const { rows } = await pool.query<{
    from_status: string | null;
    to_status: string;
    actor_id: string | null;
    reason: string | null;
  }>(
    `SELECT from_status, to_status, actor_id, reason FROM app.quotation_status_history
      WHERE version_id = $1 ORDER BY at, id`,
    [versionId],
  );
  return rows;
}

async function expiredHistory(versionId: string) {
  return (await historyRows(versionId)).filter((r) => r.to_status === 'expired');
}

async function bellRows(scope: TestScope, versionId: string) {
  const { rows } = await pool.query<{ user_id: string; title: string; link: string }>(
    `SELECT user_id, title, link FROM app.notifications WHERE tenant_id = $1 AND dedupe_key = $2`,
    [scope.tenantId, `quotation.expired:${versionId}`],
  );
  return rows;
}

async function auditEvents(scope: TestScope, versionId: string) {
  const events = await audit.list(scope, {
    entityType: 'quotation_version',
    entityId: versionId,
    limit: 100,
  });
  return events.filter((e) => e.action === 'quotation.expired');
}

/** The accept's own conditional update (Q3a's accept does the same): only a sent version becomes accepted. */
const acceptSql = (versionId: string) => sql`
  UPDATE app.quotation_versions SET status = 'accepted', accepted_at = now()
   WHERE id = ${versionId}::uuid AND status = 'sent' RETURNING id`;

// ------------------------------------------------------------------------------------------- tests

describe('quotation expiry job', () => {
  it('expires a sent and an approved version past valid_until, in every tenant, and records it', async () => {
    const a = await newScope();
    const b = await newScope();
    const sent = await seedVersion(a, { status: 'sent', validUntil: YESTERDAY });
    const approved = await seedVersion(b, { status: 'approved', validUntil: YESTERDAY });
    const before = await versionRow(sent.versionId);

    await sweeper.sweep();

    const row = await versionRow(sent.versionId);
    expect(row.status).toBe('expired');
    expect(row.expired_at?.toISOString()).toBe(NOW.toISOString());
    expect(row.version).toBe(before.version + 1);
    expect((await versionRow(approved.versionId)).status).toBe('expired');

    // One history row each, from the status it was in, with no user (the system acted).
    expect(await expiredHistory(sent.versionId)).toEqual([
      { from_status: 'sent', to_status: 'expired', actor_id: null, reason: 'valid_until passed' },
    ]);
    expect(await expiredHistory(approved.versionId)).toEqual([
      {
        from_status: 'approved',
        to_status: 'expired',
        actor_id: null,
        reason: 'valid_until passed',
      },
    ]);

    // One audit event and one bell notice for the quotation's owner, in the version's own tenant.
    expect(await auditEvents(a, sent.versionId)).toHaveLength(1);
    const bell = await bellRows(a, sent.versionId);
    expect(bell).toHaveLength(1);
    expect(first(bell).user_id).toBe(a.ownerUserId);
    expect(first(bell).title).toContain(sent.number);
    expect(first(bell).link).toBe(`/quotations/${sent.quotationId}`);
    expect(await bellRows(b, approved.versionId)).toHaveLength(1);
    // The email outbox is not used: the customer-facing K5 template is never sent to staff.
    const outbox = await pool.query(
      `SELECT 1 FROM app.outbox WHERE tenant_id = $1 AND template = 'quotation.expired'`,
      [a.tenantId],
    );
    expect(outbox.rowCount).toBe(0);
  });

  it('expires a version without an owner and notifies nobody', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope, { status: 'sent', validUntil: YESTERDAY, owner: false });
    await sweeper.sweep();
    expect((await versionRow(v.versionId)).status).toBe('expired');
    expect(await expiredHistory(v.versionId)).toHaveLength(1);
    expect(await bellRows(scope, v.versionId)).toHaveLength(0);
  });

  it('leaves a version that is still valid alone, including one valid until today', async () => {
    const scope = await newScope();
    const today = await seedVersion(scope, { status: 'sent', validUntil: TODAY });
    const later = await seedVersion(scope, { status: 'approved', validUntil: NEXT_WEEK });
    const before = [await versionRow(today.versionId), await versionRow(later.versionId)];

    await sweeper.sweep();

    expect(await versionRow(today.versionId)).toEqual(before[0]);
    expect(await versionRow(later.versionId)).toEqual(before[1]);
    expect(await historyRows(today.versionId)).toEqual([]);
    expect(await bellRows(scope, today.versionId)).toHaveLength(0);
  });

  it('a second run changes nothing more', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope, { status: 'sent', validUntil: YESTERDAY });
    await sweeper.sweep();
    const afterFirst = await versionRow(v.versionId);

    await sweeper.sweep();
    await sweeper.sweep();

    expect(await versionRow(v.versionId)).toEqual(afterFirst);
    expect(await expiredHistory(v.versionId)).toHaveLength(1);
    expect(await auditEvents(scope, v.versionId)).toHaveLength(1);
    expect(await bellRows(scope, v.versionId)).toHaveLength(1);
  });

  it('never touches an accepted version, even past valid_until', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope, { status: 'sent', validUntil: YESTERDAY });
    await withTx(db, scope, seedActor(), (tx) => tx.execute(acceptSql(v.versionId)));
    const before = await versionRow(v.versionId);

    await sweeper.sweep();

    expect(before.status).toBe('accepted');
    expect(await versionRow(v.versionId)).toEqual(before);
    expect(await expiredHistory(v.versionId)).toEqual([]);
    expect(await auditEvents(scope, v.versionId)).toHaveLength(0);
    expect(await bellRows(scope, v.versionId)).toHaveLength(0);
  });

  it('an accept that is still committing wins: the job waits on the lock, then skips the version', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope, { status: 'sent', validUntil: YESTERDAY });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted!: () => void;
    const acceptDone = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    // The accept updates the row and holds its transaction open until released.
    const accept = withTx(db, scope, seedActor(), async (tx) => {
      const rows = await tx.execute(acceptSql(v.versionId));
      expect(rows.rows).toHaveLength(1);
      accepted();
      await gate;
    });
    await acceptDone;

    // The sweep reads the version as still sent (the accept is uncommitted), then blocks on its row lock.
    const sweep = sweeper.sweep();
    await new Promise((resolve) => setTimeout(resolve, 750));
    release();
    await accept;
    const result = await sweep;

    expect(result.failed).toBe(0);
    const row = await versionRow(v.versionId);
    expect(row.status).toBe('accepted');
    expect(row.expired_at).toBeNull();
    expect(await expiredHistory(v.versionId)).toEqual([]);
    expect(await bellRows(scope, v.versionId)).toHaveLength(0);
  });

  it('an expiry that commits first wins: a later accept matches nothing', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope, { status: 'sent', validUntil: YESTERDAY });

    await sweeper.sweep();
    const accepted = await withTx(db, scope, seedActor(), (tx) =>
      tx.execute(acceptSql(v.versionId)),
    );

    expect(accepted.rows).toHaveLength(0);
    const row = await versionRow(v.versionId);
    expect(row.status).toBe('expired');
    expect(row.accepted_at).toBeNull();
    expect(await expiredHistory(v.versionId)).toHaveLength(1);
  });
});
