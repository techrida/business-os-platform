// Integration test of the portal reads on a real database (Testcontainers): PortalService over the real
// DrizzlePortalQuotationStore and SettingsService. It pins the SQL scope that the unit tests fake: a customer sees
// only quotations of its own party in the acting entity (ADR 0027 §5), so another party's quotation, the same
// party's quotation in another entity, a draft and a never-sent revision all answer 404, and the list holds only
// the newest customer-visible version of each own quotation. Seeds copy quotation-render.integration.test.ts: rows
// are moved to `sent` the way the app does (submit snapshot, approve, send), never inserted in that state.
// PA-3 adds accept and reject: PortalRespondService over the real DrizzlePortalRespondStore and the real
// QuotationOutcomeService (settings, audit, opportunities), as a real portal user, with notify faked.
// The PDF link (`quotationPdfLink`) runs over a real DocumentsService (disk storage on a temp dir, the real
// ScanProcessor against the fake clamd, real SignedLinks): only an own, customer-visible version whose rendered PDF
// scanned clean gets a link, and the link redeems once.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  createParty,
  createPortalUser,
  createTenantWithEntity,
  runMigrations,
  type Party,
} from '@bos/db';
import { HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { ClamdClient } from '../../platform/documents/clamd.client';
import { DocumentsService, type GeneratedFile } from '../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import type { NotifyService } from '../../platform/notify/notify.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { readEvidenceState } from '../quotations/outcome/evidence-state';
import { QuotationOutcomeService } from '../quotations/outcome/quotation-outcome.service';
import { QUOTATION_OWNER_TYPE } from '../quotations/quotation-owner.policy';
import { PortalRespondService } from './portal-respond.service';
import { PortalService } from './portal.service';
import { DrizzlePortalQuotationStore, DrizzlePortalRespondStore } from './portal.store';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SIGNING_SECRET = 'an-integration-test-secret-of-32-plus-chars';
const RENDER_JOB = 'quotation-render';
const SIGNED_PATH = /^\/v1\/files\/[A-Za-z0-9._~-]+$/;

class MemoryLinkStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const ADDRESS = { line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let settings: SettingsService;
let outcomes: QuotationOutcomeService;
let storageRoot: string;
let documents: DocumentsService;
let scanner: ScanProcessor;
let fakeClamd: FakeClamd;

/** Inside the seeded validity (issue 2026-11-09, valid until 2026-12-09): 2026-11-10 in Kathmandu. */
const NOW = new Date('2026-11-10T06:00:00Z');
const clock = () => NOW;
const notify = {
  notifyUser: vi.fn(() => Promise.resolve()),
  nudge: vi.fn(() => Promise.resolve()),
};

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
  const audit = new AuditService(db);
  // markWon reads neither authz nor the caller: it is a system move inside the outcome's transaction.
  const opportunities = new OpportunitiesService(db, {} as never, audit, {} as never, {} as never);
  outcomes = new QuotationOutcomeService(
    settings,
    opportunities,
    notify as unknown as NotifyService,
    audit,
    clock,
  );

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-portal-pdf-'));
  const storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SIGNING_SECRET, new MemoryLinkStore(), () => Date.now()),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    { assert: vi.fn() },
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  // Let the render job attach to a `sent` version: the real policy only allows an approved one, and this test is
  // about the portal's link, not the render job.
  documents.registerOwner({
    ownerType: QUOTATION_OWNER_TYPE,
    resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
    allowsSystemActor: () => Promise.resolve(true),
  });
  fakeClamd = await startFakeClamd();
  scanner = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    { record: vi.fn().mockResolvedValue(undefined) },
    { notifyUser: vi.fn().mockResolvedValue(undefined) },
  );
});

afterAll(async () => {
  await fakeClamd?.close();
  await pool?.end();
  await container?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
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
  /** The IdP org behind partyP, for its portal user. */
  idpOrgP: string;
  /** Another customer of the same tenant. */
  partyQ: string;
  taxCodeId: string;
}

async function seedCustomer(scope: TxScope, name: string): Promise<Party> {
  const party = await createParty(pool, { tenantId: scope.tenantId, kind: 'customer' });
  const { partyId } = party;
  await withTx(db, scope, seedActor(), (tx) =>
    tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
      VALUES (${partyId}::uuid, ${scope.tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              ${name}, ${name.toLowerCase()}, ${JSON.stringify(ADDRESS)}::jsonb)`),
  );
  return party;
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
  const { partyId: partyP, idpOrgId: idpOrgP } = await seedCustomer(scopeA, 'Himal Traders');
  const { partyId: partyQ } = await seedCustomer(scopeA, 'Other Buyer');
  const taxCodeId = await withTx(db, scopeA, seedActor(), async (tx) => {
    const taxCode = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
      VALUES (${tenantId}::uuid, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`);
    await settings.set(tx, 'entity.address', ADDRESS);
    await settings.set(tx, 'entity.pan_vat_no', '301234567');
    return first(taxCode.rows).id;
  });
  return { tenantId, entityA, entityB, partyP, idpOrgP, partyQ, taxCodeId };
}

interface Seeded {
  /** A sent quotation's opportunity is at quotation_sent, so an acceptance can move it to won. */
  opportunityId: string;
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
      INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id, stage)
      VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${`DEAL-${randomUUID().slice(0, 8)}`},
              'Solar', ${party}::uuid, ${status === 'sent' ? 'quotation_sent' : 'qualified'})
      RETURNING id`);
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
    return { quotationId, versionId, number, opportunityId: first(opp.rows).id };
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
      (tenant_id, organization_id, quotation_id, revision_no, supersedes_version_id, revision_reason, currency,
       issue_date, valid_until, scope, delivery_timeline, payment_schedule, subtotal, discount_amount,
       taxable_amount, tax_amount, total)
    VALUES (${w.tenantId}::uuid, ${entity}::uuid, ${quotationId}::uuid, ${revisionNo}, ${supersedes}::uuid,
            ${revisionNo > 1 ? 'Customer asked for a lower price' : null},
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

function customerOf(
  w: World,
  entity: string,
  party: string,
  userId: string = randomUUID(),
): Principal {
  return {
    userId,
    zitadelUserId: 'zitadel-sub-portal',
    tenantId: w.tenantId,
    organizationId: entity,
    orgKind: 'customer',
    partyId: party,
    idpOrgId: randomUUID(),
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map([
      ['portal.quotation.read', 'customer_org'],
      ['portal.quotation.respond', 'customer_org'],
    ]),
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

/** The portal over the real documents module: for the PDF link, which reads the rendered document's scan status. */
function serviceWithDocuments(p: Principal): PortalService {
  return new PortalService(
    { current: () => p },
    new DrizzlePortalQuotationStore(db),
    documents,
    settings,
  );
}

const pdf = (): GeneratedFile => ({
  filename: 'QT-1-R1.pdf',
  declaredMime: 'application/pdf',
  bytes: Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    Buffer.alloc(200, 0x20),
  ]),
});

/**
 * The rendered PDF of a version the way the render job leaves it: a document of the quotation's own entity, received
 * and (unless `scan` is false, which leaves it quarantined) clean, then recorded on the version.
 * Returns the document id and its version id.
 */
async function renderPdf(
  w: World,
  entity: string,
  versionId: string,
  opts: { scan?: boolean } = {},
): Promise<{ documentId: string; documentVersionId: string }> {
  const scope: TxScope = { tenantId: w.tenantId, organizationId: entity };
  const file = pdf();
  const who = { scope, actor: systemActor(RENDER_JOB) };
  const created = await withTx(db, who.scope, who.actor, (tx) =>
    documents.createGenerated(tx, { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId }, file),
  );
  if (opts.scan === false) {
    // The ordinary receive path (it always queues a scan), so the file sits in quarantine until a scan runs.
    await documents.receiveContent(
      created.versionId,
      Readable.from(file.bytes),
      file.bytes.length,
      {
        documentId: created.documentId,
        who,
      },
    );
  } else {
    // Generated bytes skip the scan (D28): clean at once.
    await documents.receiveGenerated(created, file, who);
  }
  await withTx(db, scope, seedActor(), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions SET render_state = 'pending' WHERE id = ${versionId}::uuid`,
    );
    await tx.execute(sql`
      UPDATE app.quotation_versions
         SET render_state = 'rendered', rendered_document_id = ${created.documentId}::uuid,
             rendered_sha256 = decode(repeat('cd', 32), 'hex')
       WHERE id = ${versionId}::uuid`);
  });
  return { documentId: created.documentId, documentVersionId: created.versionId };
}

const tokenOf = (url: string): string => url.replace(/^\/v1\/files\//, '');

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

// ---------------------------------------------------------------------------------------- accept and reject

/** A customer of partyP in entity A with a real app.users row (the acceptance and history rows reference it). */
async function portalCustomer(w: World): Promise<Principal> {
  const { userId } = await createPortalUser(pool, { tenantId: w.tenantId, idpOrgId: w.idpOrgP });
  return customerOf(w, w.entityA, w.partyP, userId);
}

function respondFor(p: Principal): PortalRespondService {
  const actor: Actor = { kind: 'user', id: p.userId, correlationId: `req-${randomUUID()}` };
  return new PortalRespondService(
    db,
    { current: () => p },
    { current: () => actor },
    new DrizzlePortalRespondStore(),
    outcomes,
    notify as unknown as NotifyService,
    clock,
  );
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return {
        status: error.getStatus(),
        code: typeof body === 'object' && 'code' in body ? body.code : undefined,
      };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
}

async function versionState(versionId: string) {
  const { rows } = await pool.query<{ status: string; rejection_source: string | null }>(
    'SELECT status, rejection_source FROM app.quotation_versions WHERE id = $1',
    [versionId],
  );
  return first(rows);
}

async function opportunityState(opportunityId: string) {
  const { rows } = await pool.query<{ stage: string; won_quotation_version_id: string | null }>(
    'SELECT stage, won_quotation_version_id FROM app.opportunities WHERE id = $1',
    [opportunityId],
  );
  return first(rows);
}

async function acceptanceCount(versionId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.quotation_acceptances WHERE version_id = $1',
    [versionId],
  );
  return Number(first(rows).n);
}

const SIGNED = { acceptedByName: 'Ram Thapa', confirm: true };

describe('portal accept and reject on a real database', () => {
  it('accepts an own sent version, wins the opportunity, replays the same body, then answers 409', async () => {
    notify.nudge.mockClear();
    const w = await seedWorld();
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const respond = respondFor(await portalCustomer(w));
    const key = `accept-${randomUUID()}`;

    const answer = await respond.accept(sent.versionId, key, SIGNED);
    expect(answer).toEqual({ id: sent.versionId, status: 'accepted', decidedOn: '2026-11-10' });
    expect(await versionState(sent.versionId)).toMatchObject({ status: 'accepted' });
    expect(await opportunityState(sent.opportunityId)).toEqual({
      stage: 'won',
      won_quotation_version_id: sent.versionId,
    });
    expect(notify.nudge).toHaveBeenCalledTimes(1);

    // A retry after a timeout: the same key and body replay the stored answer, and nothing happens twice.
    await expect(respond.accept(sent.versionId, key, SIGNED)).resolves.toEqual(answer);
    expect(await acceptanceCount(sent.versionId)).toBe(1);
    expect(notify.nudge).toHaveBeenCalledTimes(1);

    // A new answer to a version that is already answered: "already answered", not "not found".
    expect(await failure(respond.accept(sent.versionId, `again-${randomUUID()}`, SIGNED))).toEqual({
      status: 409,
      code: 'quotation_not_sent',
    });
    expect(
      await failure(respond.reject(sent.versionId, `again-${randomUUID()}`, { comment: 'No' })),
    ).toEqual({ status: 409, code: 'quotation_not_sent' });
  });

  it('accepts under a contract policy instead of dead-ending, and leaves the evidence for staff (F1-Q28)', async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    await withTx(db, scopeA, seedActor(), (tx) =>
      settings.set(tx, 'sales.evidence_policy', 'both'),
    );
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const customer = await portalCustomer(w);
    const respond = respondFor(customer);

    await expect(respond.accept(sent.versionId, `accept-${randomUUID()}`, SIGNED)).resolves.toEqual(
      { id: sent.versionId, status: 'accepted', decidedOn: '2026-11-10' },
    );
    expect(await versionState(sent.versionId)).toMatchObject({ status: 'accepted' });
    const evidence = await withTx(db, scopeA, seedActor(), (tx) =>
      readEvidenceState(tx, scopeA, sent.versionId),
    );
    expect(evidence).toMatchObject({
      status: 'pending',
      kinds: ['signed_quote'],
      confirmation: null,
    });
    expect(evidence?.acceptance).toMatchObject({
      actorKind: 'customer_user',
      acceptedByName: 'Ram Thapa',
    });
    // The same customer reloads the quotation and is told what happens next, not left at an error.
    expect((await serviceFor(customer).get(sent.versionId)).afterAcceptance).toEqual({
      status: 'pending',
      needs: ['contract', 'purchase_order'],
    });
  });

  it('answers 404 for another party, another entity, a draft and an unknown id, and changes nothing', async () => {
    const w = await seedWorld();
    const otherParty = await seedQuotation(w, w.entityA, w.partyQ, 'sent');
    const otherEntity = await seedQuotation(w, w.entityB, w.partyP, 'sent');
    const draft = await seedQuotation(w, w.entityA, w.partyP, 'draft');
    const respond = respondFor(await portalCustomer(w));

    for (const [name, id] of [
      ['other party', otherParty.versionId],
      ['other entity', otherEntity.versionId],
      ['draft', draft.versionId],
      ['unknown', randomUUID()],
    ] as const) {
      expect(await failure(respond.accept(id, `k-${randomUUID()}`, SIGNED)), name).toEqual({
        status: 404,
        code: 'not_found',
      });
      expect(
        await failure(respond.reject(id, `k-${randomUUID()}`, { comment: 'No' })),
        name,
      ).toEqual({ status: 404, code: 'not_found' });
    }
    expect(await versionState(otherParty.versionId)).toMatchObject({ status: 'sent' });
    expect(await versionState(otherEntity.versionId)).toMatchObject({ status: 'sent' });
    expect(await opportunityState(otherParty.opportunityId)).toMatchObject({
      stage: 'quotation_sent',
    });
  });

  it('rejects only with a comment, as the customer, and leaves the opportunity open', async () => {
    const w = await seedWorld();
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const respond = respondFor(await portalCustomer(w));

    for (const body of [{}, { comment: '' }, { comment: '   ' }]) {
      expect(
        (await failure(respond.reject(sent.versionId, `k-${randomUUID()}`, body))).status,
      ).toBe(400);
    }
    expect(await versionState(sent.versionId)).toMatchObject({ status: 'sent' });

    await expect(
      respond.reject(sent.versionId, `k-${randomUUID()}`, { comment: 'Too expensive' }),
    ).resolves.toEqual({ id: sent.versionId, status: 'rejected', decidedOn: '2026-11-10' });
    expect(await versionState(sent.versionId)).toEqual({
      status: 'rejected',
      rejection_source: 'customer',
    });
    expect(await opportunityState(sent.opportunityId)).toMatchObject({ stage: 'quotation_sent' });
  });
});

// ---------------------------------------------------------------------------------------- PDF link

describe('portal PDF link on a real database', () => {
  it('links a clean rendered PDF of an own sent version, and the link redeems once', async () => {
    const w = await seedWorld();
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    await renderPdf(w, w.entityA, sent.versionId);
    const portal = serviceWithDocuments(customerOf(w, w.entityA, w.partyP));

    const link = await portal.quotationPdfLink(sent.versionId);
    // The form the portal's BFF accepts before it fetches anything.
    expect(link.url).toMatch(SIGNED_PATH);

    const opened = await documents.openDownload(tokenOf(link.url));
    expect(opened.mime).toBe('application/pdf');
    expect(opened.filename).toBe('QT-1-R1.pdf');
    opened.stream.destroy();
    await expect(documents.openDownload(tokenOf(link.url))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('answers 404 while the rendered PDF is quarantined, then links once it is clean', async () => {
    const w = await seedWorld();
    const sent = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const { documentVersionId } = await renderPdf(w, w.entityA, sent.versionId, { scan: false });
    const portal = serviceWithDocuments(customerOf(w, w.entityA, w.partyP));

    await expect(portal.quotationPdfLink(sent.versionId)).rejects.toBeInstanceOf(NotFoundException);

    const scope: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    expect(await scanner.scanVersion({ versionId: documentVersionId, ...scope }, true)).toBe(
      'clean',
    );
    const link = await portal.quotationPdfLink(sent.versionId);
    expect(link.url).toMatch(SIGNED_PATH);
  });

  it('answers 404 for another party, another entity, a draft, an unrendered version and an unknown id', async () => {
    const w = await seedWorld();
    // Each one that can has a clean rendered PDF, so its 404 comes from the portal's scope, not from the scan.
    const otherParty = await seedQuotation(w, w.entityA, w.partyQ, 'sent');
    await renderPdf(w, w.entityA, otherParty.versionId);
    const otherEntity = await seedQuotation(w, w.entityB, w.partyP, 'sent');
    await renderPdf(w, w.entityB, otherEntity.versionId);
    const draft = await seedQuotation(w, w.entityA, w.partyP, 'draft');
    await renderPdf(w, w.entityA, draft.versionId);
    const unrendered = await seedQuotation(w, w.entityA, w.partyP, 'sent');
    const portal = serviceWithDocuments(customerOf(w, w.entityA, w.partyP));

    for (const [name, id] of [
      ['other party', otherParty.versionId],
      ['other entity', otherEntity.versionId],
      ['draft', draft.versionId],
      ['not rendered', unrendered.versionId],
      ['unknown', randomUUID()],
    ] as const) {
      await expect(portal.quotationPdfLink(id), name).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});
