// Integration test of the portal reads on a real database (Testcontainers): PortalService over the real
// DrizzlePortalQuotationStore and SettingsService. It pins the SQL scope that the unit tests fake: a customer sees
// only quotations of its own party in the acting entity (ADR 0027 §5), so another party's quotation, the same
// party's quotation in another entity, a draft and a never-sent revision all answer 404, and the list holds only
// the newest customer-visible version of each own quotation. Seeds copy quotation-render.integration.test.ts: rows
// are moved to `sent` the way the app does (submit snapshot, approve, send), never inserted in that state.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { createParty, createTenantWithEntity, runMigrations } from '@bos/db';
import { NotFoundException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { SettingsService } from '../../platform/settings/settings.service';
import { PortalService } from './portal.service';
import { DrizzlePortalQuotationStore } from './portal.store';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const ADDRESS = { line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let settings: SettingsService;

const seedActor = () => systemActor('portal-test-seed');

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

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

  pool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
  db = drizzle({ client: pool });
  settings = new SettingsService(db);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// ---------------------------------------------------------------------------------------- seed

interface World {
  tenantId: string;
  /** The tenant's default entity. */
  entityA: string;
  /** A second legal entity of the same tenant. */
  entityB: string;
  /** The caller's party. */
  partyP: string;
  /** Another customer of the same tenant. */
  partyQ: string;
  taxCodeId: string;
}

async function seedCustomer(scope: TxScope, name: string): Promise<string> {
  const { partyId } = await createParty(pool, { tenantId: scope.tenantId, kind: 'customer' });
  await withTx(db, scope, seedActor(), (tx) =>
    tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
      VALUES (${partyId}::uuid, ${scope.tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              ${name}, ${name.toLowerCase()}, ${JSON.stringify(ADDRESS)}::jsonb)`),
  );
  return partyId;
}

async function seedWorld(): Promise<World> {
  const { tenantId, organizationId: entityA } = await createTenantWithEntity(pool);
  const scopeA: TxScope = { tenantId, organizationId: entityA };
  const entityB = randomUUID();
  await withTx(db, scopeA, seedActor(), (tx) =>
    tx.execute(sql`
      INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
      VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`},
              ${`E-${entityB}`}, false)`),
  );
  const partyP = await seedCustomer(scopeA, 'Himal Traders');
  const partyQ = await seedCustomer(scopeA, 'Other Buyer');
  const taxCodeId = await withTx(db, scopeA, seedActor(), async (tx) => {
    const taxCode = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
      VALUES (${tenantId}::uuid, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`);
    await settings.set(tx, 'entity.address', ADDRESS);
    await settings.set(tx, 'entity.pan_vat_no', '301234567');
    return first(taxCode.rows).id;
  });
  return { tenantId, entityA, entityB, partyP, partyQ, taxCodeId };
}

interface Seeded {
  quotationId: string;
  versionId: string;
  number: string;
}

/** One quotation of `party` in `entity` with one version (one line, one tax row), moved to `status` as the app does. */
async function seedQuotation(
  w: World,
  entity: string,
  party: string,
  status: 'draft' | 'sent',
): Promise<Seeded> {
  const scope: TxScope = { tenantId: w.tenantId, organizationId: entity };
  const number = `QT-${randomUUID().slice(0, 8)}`;
  return withTx(db, scope, seedActor(), async (tx) => {
    const opp = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
      VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${`DEAL-${randomUUID().slice(0, 8)}`},
              'Solar', ${party}::uuid) RETURNING id`);
    const quotation = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
      VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${number}, ${party}::uuid,
              ${first(opp.rows).id}::uuid) RETURNING id`);
    const quotationId = first(quotation.rows).id;
    const versionId = await insertDraft(tx, w, entity, quotationId, 1, null);
    if (status === 'sent') {
      await tx.execute(sql`
        UPDATE app.quotation_versions
           SET status = 'submitted', submitted_at = now(), fx_rate = 1, amount_npr = total,
               npr_taxable_amount = taxable_amount, content_sha256 = decode(repeat('ab', 32), 'hex'),
               snapshot_sha256 = decode(repeat('ab', 32), 'hex')
         WHERE id = ${versionId}::uuid`);
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now() WHERE id = ${versionId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now() WHERE id = ${versionId}::uuid`,
      );
    }
    return { quotationId, versionId, number };
  });
}

type SeedTx = Parameters<Parameters<typeof withTx>[3]>[0];

async function insertDraft(
  tx: SeedTx,
  w: World,
  entity: string,
  quotationId: string,
  revisionNo: number,
  supersedes: string | null,
): Promise<string> {
  const version = await tx.execute<{ id: string }>(sql`
    INSERT INTO app.quotation_versions
      (tenant_id, organization_id, quotation_id, revision_no, supersedes_version_id, currency, issue_date,
       valid_until, scope, delivery_timeline, payment_schedule, subtotal, discount_amount, taxable_amount,
       tax_amount, total)
    VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${quotationId}::uuid, ${revisionNo}, ${supersedes}::uuid,
            'NPR', '2026-11-09', '2026-12-09', 'Supply and install 12 panels', '6 weeks',
            ${JSON.stringify([{ label: 'Advance', percent: '100' }])}::jsonb,
            1000, 0, 1000, 130, 1130) RETURNING id`);
  const id = first(version.rows).id;
  await tx.execute(sql`
    INSERT INTO app.quotation_lines
      (tenant_id, organization_id, version_id, line_no, description, uom, quantity, unit_price, tax_code_id,
       gross, discount_alloc, taxable)
    VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${id}::uuid, 1, 'Solar panel', 'pcs', 1, 1000,
            ${w.taxCodeId}::uuid, 1000, 0, 1000)`);
  await tx.execute(sql`
    INSERT INTO app.quotation_tax_summary
      (tenant_id, organization_id, version_id, tax_code_id, label, rate, base, tax)
    VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${id}::uuid, ${w.taxCodeId}::uuid, 'VAT', 13, 1000, 130)`);
  return id;
}

/** Revises a sent version in the schema's order: old -> superseded, insert the draft, then link old to it. */
async function reviseToDraft(w: World, entity: string, sent: Seeded): Promise<string> {
  const scope: TxScope = { tenantId: w.tenantId, organizationId: entity };
  return withTx(db, scope, seedActor(), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'superseded' WHERE id = ${sent.versionId}::uuid`,
    );
    const draftId = await insertDraft(tx, w, entity, sent.quotationId, 2, sent.versionId);
    await tx.execute(sql`
      UPDATE app.quotation_versions SET superseded_by_version_id = ${draftId}::uuid
       WHERE id = ${sent.versionId}::uuid`);
    return draftId;
  });
}

function customerOf(w: World, entity: string, party: string): Principal {
  return {
    userId: randomUUID(),
    zitadelUserId: 'zitadel-sub-portal',
    tenantId: w.tenantId,
    organizationId: entity,
    orgKind: 'customer',
    partyId: party,
    idpOrgId: randomUUID(),
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map([['portal.quotation.read', 'customer_org']]),
  };
}

function serviceFor(p: Principal): PortalService {
  const caller = { current: () => p };
  // No version here is rendered, so the documents lookup is never reached.
  const documents = { listForOwner: vi.fn().mockResolvedValue([]) };
  return new PortalService(
    caller,
    new DrizzlePortalQuotationStore(db),
    documents as never,
    settings,
  );
}

// ---------------------------------------------------------------------------------------- tests

describe('portal reads on a real database', () => {
  it('scopes to the caller party in the acting entity and never shows a draft', async () => {
    const w = await seedWorld();
    const ownSent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const otherEntity = await seedQuotation(w, w.entityB, w.partyP, 'sent');
    const otherParty = await seedQuotation(w, w.entityA, w.partyQ, 'sent');
    const draftOnly = await seedQuotation(w, w.entityA, w.partyP, 'draft');
    const revised = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const revisionDraftId = await reviseToDraft(w, w.entityA, revised);

    const portal = serviceFor(customerOf(w, w.entityA, w.partyP));

    const items = await portal.list();
    expect(items.map((i) => i.id).sort()).toEqual([ownSent.versionId, revised.versionId].sort());
    expect(items.find((i) => i.id === revised.versionId)).toMatchObject({
      number: revised.number,
      revisionNo: 1,
      status: 'superseded',
    });

    await expect(portal.get(ownSent.versionId)).resolves.toMatchObject({
      id: ownSent.versionId,
      number: ownSent.number,
      status: 'sent',
      customer: { legalName: 'Himal Traders' },
      issuer: { panVatNo: '301234567' },
    });
    await expect(portal.get(revised.versionId)).resolves.toMatchObject({ status: 'superseded' });

    for (const [name, id] of [
      ['cross-entity', otherEntity.versionId],
      ['other party', otherParty.versionId],
      ['draft only', draftOnly.versionId],
      ['unsent revision', revisionDraftId],
      ['unknown', randomUUID()],
    ] as const) {
      await expect(portal.get(id), name).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('lets the same party acting in the other entity see only that entity', async () => {
    const w = await seedWorld();
    await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const inB = await seedQuotation(w, w.entityB, w.partyP, 'sent');

    const items = await serviceFor(customerOf(w, w.entityB, w.partyP)).list();
    expect(items.map((i) => i.id)).toEqual([inB.versionId]);
  });

  it('gives a customer principal without the grant nothing', async () => {
    const w = await seedWorld();
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const p = { ...customerOf(w, w.entityA, w.partyP), grants: new Map() };
    const portal = serviceFor(p);
    await expect(portal.list()).resolves.toEqual([]);
    await expect(portal.get(sent.versionId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
