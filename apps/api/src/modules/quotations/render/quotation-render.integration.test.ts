// The quotation render sweeper against real Postgres (P2 unit R3). The real store, the real GotenbergClient
// talking over HTTP to a fake Gotenberg (a node:http server that answers one fixed PDF), the real DocumentsService
// on a temp dir with the real QuotationOwnerPolicy registered as `quotation_version`, and the real ScanProcessor
// against the fake clamd. Fakes: authz (it must never be called on the system path), audit, the scan queue.
//
// What it holds:
//   * selection: approved with state none is picked; failed only after the pause its attempts call for and never at
//     the try limit (render-retry.ts), pending only after 10 min; rendered, draft and sent versions never;
//   * a render that keeps failing (round 4, R4c2: TR-Q4, F1-Q13) counts its attempts, is given up at the limit with one
//     admin entry `quotation.pdf_render_failed` on the quotation, and a success resets the count;
//   * an approved version ends `rendered` with one document, a 32-byte rendered_sha256 that matches the document
//     version, and the document is clean at once (a generated file skips the virus scan, D28; no scan job is queued);
//   * the render update passes the frozen guard (the version stays approved, its content stays frozen);
//   * a second sweep adds no document, and two renders at once give one `rendered` and one `skipped`;
//   * Gotenberg answering 500, an unset entity address, and a version that leaves approved mid-flight each mark
//     the version `failed` and leave no document;
//   * an orphan generated document older than 1 h is soft-removed, a younger one is kept.
//
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/render/quotation-render.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createParty, createTenantWithEntity } from '@bos/db';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { ClamdClient } from '../../../platform/documents/clamd.client';
import {
  DocumentsService,
  type GeneratedFile,
} from '../../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import { SettingsService } from '../../../platform/settings/settings.service';
import { AuditService } from '../../../platform/audit/audit.service';
import {
  drizzleHeadLoader,
  QUOTATION_OWNER_TYPE,
  QUOTATION_RENDER_JOB_PREFIX,
  QuotationOwnerPolicy,
} from '../quotation-owner.policy';
import { GotenbergClient } from './gotenberg.client';
import { NO_DOCUMENT_LOGO_RESOLVER } from './issuer';
import {
  drizzleRenderStore,
  ORPHAN_AFTER_MS,
  PENDING_STALE_MS,
  QuotationRenderSweeper,
  type PdfRenderer,
  type RenderCandidate,
  type RunInTx,
} from './quotation-render.sweeper';
import { MAX_RENDER_ATTEMPTS, nextRetryPauseMs, RETRY_PAUSE_BASE_MS } from './render-retry';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
// The `entity.address` setting and the customer's address columns: line, city, country (FX9).
const ADDRESS = { line: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' };

// What the fake Gotenberg answers: a small, valid-looking PDF, always the same bytes.
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
  Buffer.alloc(200, 0x20),
]);
const PDF_SHA256 = createHash('sha256').update(PDF).digest('hex');

class MemoryStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

interface TestScope extends TxScope {
  customerId: string;
  taxCodeId: string;
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let storageRoot: string;
let storage: DiskStorageAdapter;
let documents: DocumentsService;
let settings: SettingsService;
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let gotenbergServer: Server;
let gotenbergUrl: string;
let sweeper: QuotationRenderSweeper;
let store: ReturnType<typeof drizzleRenderStore>;
/** The real audit log the sweeper writes its admin entry to. */
let renderAudit: AuditService;

/** What the fake Gotenberg is told to do, and what it saw. */
const gotenberg = {
  mode: 'ok' as 'ok' | 'error',
  requests: [] as string[],
};

const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };

const runTx: RunInTx = (scope, actor, fn) => withTx(db, scope, actor, fn);
const seedActor = () => systemActor('quotation-render-test-seed');
const renderActor = () => systemActor(QUOTATION_RENDER_JOB_PREFIX);

/** The scopes this test created; their approved versions are retired afterwards so no sweep finds them again. */
let scopes: TestScope[] = [];

const ts = (date: Date) => date.toISOString();

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });

  gotenbergServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      gotenberg.requests.push(Buffer.concat(chunks).toString('utf8'));
      if (gotenberg.mode === 'error') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('chromium crashed');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
      res.end(PDF);
    });
  });
  await new Promise<void>((resolve) => gotenbergServer.listen(0, '127.0.0.1', resolve));
  gotenbergUrl = `http://127.0.0.1:${(gotenbergServer.address() as AddressInfo).port}`;

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-quotation-render-'));
  storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  // The real policy of a quotation version, as the worker module registers it.
  documents.registerOwner(new QuotationOwnerPolicy(drizzleHeadLoader(db)));
  settings = new SettingsService(db);
  store = drizzleRenderStore(db);
  renderAudit = new AuditService(db);

  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    audit,
    notify,
  );
  sweeper = makeSweeper(
    new GotenbergClient(gotenbergUrl, { timeoutMs: 10_000, maxBytes: 1_000_000 }),
  );
});

afterAll(async () => {
  await fakeClamd?.close();
  gotenbergServer?.closeAllConnections();
  await new Promise<void>((resolve) =>
    gotenbergServer ? gotenbergServer.close(() => resolve()) : resolve(),
  );
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  gotenberg.mode = 'ok';
  gotenberg.requests.length = 0;
  authz.assert.mockReset();
  audit.record.mockClear();
  queue.add.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  // Retire what this test left approved: a later sweep must not render it, and the versions stay for the record.
  for (const s of scopes) {
    await withTx(db, s, seedActor(), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'superseded'
             WHERE tenant_id = ${s.tenantId}::uuid AND status = 'approved'`,
      ),
    );
  }
  scopes = [];
});

// ---------------------------------------------------------------------------------------- helpers

function makeSweeper(pdf: PdfRenderer): QuotationRenderSweeper {
  // No entity logo is set in these tests, so the logo resolver is never asked; the unit tests cover it.
  return new QuotationRenderSweeper(
    store,
    runTx,
    documents,
    settings,
    pdf,
    () => new Date(),
    { forScope: () => NO_DOCUMENT_LOGO_RESOLVER },
    renderAudit,
  );
}

/** A tenant with its default entity, a tax code, a customer and (unless told not to) the issuing entity's settings. */
async function newScope(options: { issuer?: boolean } = {}): Promise<TestScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  const scope = { tenantId, organizationId };
  const { partyId } = await createParty(pool, { tenantId, kind: 'customer' });
  const taxCodeId = await withTx(db, scope, seedActor(), async (tx) => {
    await tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
      VALUES (${partyId}::uuid, ${tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              'Himal Traders Pvt. Ltd.', 'himal traders', ${ADDRESS.country}, ${ADDRESS.line}, ${ADDRESS.city})`);
    const taxCode = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
      VALUES (${tenantId}::uuid, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`);
    if (options.issuer !== false) {
      await settings.set(tx, 'entity.address', ADDRESS);
      await settings.set(tx, 'entity.pan_vat_no', '301234567');
    }
    return first(taxCode.rows).id;
  });
  const result = { ...scope, customerId: partyId, taxCodeId };
  scopes.push(result);
  return result;
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

interface SeedOptions {
  /** The version's status; `approved` by default. Never `rendered`: that comes from a real render. */
  status?: 'draft' | 'approved' | 'sent';
  renderState?: 'none' | 'pending' | 'failed';
  /** Failed renders so far (render_attempts); 0 by default, as for a version that failed before they were counted. */
  renderAttempts?: number;
  /** How long ago the version last changed; render retries are timed from it. */
  idleMs?: number;
}

interface Seeded extends RenderCandidate {
  number: string;
}

/** One quotation with one version, one line and one tax row, moved to `status` the way the app does. */
async function seedVersion(scope: TestScope, options: SeedOptions = {}): Promise<Seeded> {
  const status = options.status ?? 'approved';
  // The form NumberingService issues: the fiscal year carries a slash, which a file name may not.
  const number = `QT-2083/84-${randomUUID().slice(0, 8)}`;
  const { tenantId, organizationId } = scope;
  const versionId = await withTx(db, scope, seedActor(), async (tx) => {
    const opp = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${`DEAL-${randomUUID().slice(0, 8)}`},
              'Himal solar', ${scope.customerId}::uuid) RETURNING id`);
    const quotation = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${number}, ${scope.customerId}::uuid,
              ${first(opp.rows).id}::uuid) RETURNING id`);
    const version = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.quotation_versions
        (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until, scope,
         delivery_timeline, payment_schedule, subtotal, discount_amount, taxable_amount, tax_amount, total)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${first(quotation.rows).id}::uuid, 1, 'NPR',
              '2026-11-09', '2026-12-09', 'Supply and install 12 panels', '6 weeks',
              ${JSON.stringify([{ label: 'Advance', percent: '100' }])}::jsonb,
              1000, 0, 1000, 130, 1130) RETURNING id`);
    const id = first(version.rows).id;
    await tx.execute(sql`
      INSERT INTO app.quotation_lines
        (tenant_id, organization_id, version_id, line_no, description, uom, quantity, unit_price, tax_code_id,
         gross, discount_alloc, taxable)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${id}::uuid, 1, 'Solar panel', 'pcs', 1, 1000,
              ${scope.taxCodeId}::uuid, 1000, 0, 1000)`);
    await tx.execute(sql`
      INSERT INTO app.quotation_tax_summary
        (tenant_id, organization_id, version_id, tax_code_id, label, rate, base, tax)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${id}::uuid, ${scope.taxCodeId}::uuid,
              'VAT', 13, 1000, 130)`);
    if (status !== 'draft') {
      // Submit writes the frozen snapshot; approve and send only move the status.
      await tx.execute(sql`
        UPDATE app.quotation_versions
           SET status = 'submitted', submitted_at = now(), fx_rate = 1, amount_npr = total,
               npr_taxable_amount = taxable_amount, content_sha256 = decode(repeat('ab', 32), 'hex'),
               snapshot_sha256 = decode(repeat('ab', 32), 'hex')
         WHERE id = ${id}::uuid`);
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now() WHERE id = ${id}::uuid`,
      );
      if (status === 'sent') {
        await tx.execute(
          sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now() WHERE id = ${id}::uuid`,
        );
      }
    }
    if (options.renderState !== undefined || options.idleMs !== undefined) {
      const updatedAt = new Date(Date.now() - (options.idleMs ?? 0));
      await tx.execute(sql`
        UPDATE app.quotation_versions
           SET render_state = ${options.renderState ?? 'none'},
               render_attempts = ${options.renderAttempts ?? 0},
               updated_at = ${ts(updatedAt)}::timestamptz
         WHERE id = ${id}::uuid`);
    }
    return id;
  });
  return { tenantId, organizationId, versionId, number };
}

async function versionRow(versionId: string) {
  const { rows } = await pool.query<{
    status: string;
    render_state: string;
    render_attempts: number;
    quotation_id: string;
    rendered_document_id: string | null;
    rendered_sha256: Buffer | null;
  }>(
    `SELECT status, render_state, render_attempts, quotation_id, rendered_document_id, rendered_sha256
       FROM app.quotation_versions WHERE id = $1`,
    [versionId],
  );
  return first(rows);
}

async function documentRows(versionId: string) {
  const { rows } = await pool.query<{
    document_id: string;
    removed_at: Date | null;
    current_version_id: string | null;
    version_id: string;
    status: string;
    sha256: Buffer | null;
    uploaded_by: string | null;
  }>(
    `SELECT d.id AS document_id, d.removed_at, d.current_version_id, v.id AS version_id, v.status, v.sha256,
            v.uploaded_by
       FROM app.documents d JOIN app.document_versions v ON v.document_id = d.id
      WHERE d.owner_type = $1 AND d.owner_id = $2`,
    [QUOTATION_OWNER_TYPE, versionId],
  );
  return rows;
}

const scanJob = (scope: TxScope, versionId: string) => ({
  versionId,
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
});

/** An orphan: a generated document created for the version and never given its bytes. */
async function createOrphan(scope: TestScope, versionId: string, ageMs: number): Promise<string> {
  const file: GeneratedFile = {
    filename: 'orphan.pdf',
    declaredMime: 'application/pdf',
    bytes: PDF,
  };
  const created = await withTx(db, scope, renderActor(), (tx: DbTransaction) =>
    documents.createGenerated(tx, { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId }, file),
  );
  await withTx(db, scope, seedActor(), (tx) =>
    tx.execute(
      sql`UPDATE app.documents SET created_at = ${ts(new Date(Date.now() - ageMs))}::timestamptz
           WHERE id = ${created.documentId}::uuid`,
    ),
  );
  return created.documentId;
}

// ------------------------------------------------------------------------------------------- tests

describe('quotation render candidates', () => {
  it('picks approved versions that need a render and nothing else', async () => {
    const scope = await newScope();
    const fresh = await seedVersion(scope);
    // Before 0115 a failure was not counted: 0 attempts waits the first pause.
    const failedRecently = await seedVersion(scope, {
      renderState: 'failed',
      idleMs: RETRY_PAUSE_BASE_MS - 20_000,
    });
    const failedLongAgo = await seedVersion(scope, {
      renderState: 'failed',
      idleMs: RETRY_PAUSE_BASE_MS + 20_000,
    });
    // After two failures the pause is longer: the same idle time is not enough.
    const secondPause = nextRetryPauseMs(2) ?? 0;
    const failedTwiceRecently = await seedVersion(scope, {
      renderState: 'failed',
      renderAttempts: 2,
      idleMs: secondPause - 20_000,
    });
    const failedTwiceLongAgo = await seedVersion(scope, {
      renderState: 'failed',
      renderAttempts: 2,
      idleMs: secondPause + 20_000,
    });
    // Given up: never taken again, however long ago.
    const givenUp = await seedVersion(scope, {
      renderState: 'failed',
      renderAttempts: MAX_RENDER_ATTEMPTS,
      idleMs: 365 * 24 * 60 * 60_000,
    });
    const pendingRecently = await seedVersion(scope, {
      renderState: 'pending',
      idleMs: PENDING_STALE_MS - 60_000,
    });
    const pendingStale = await seedVersion(scope, {
      renderState: 'pending',
      idleMs: PENDING_STALE_MS + 60_000,
    });
    const draft = await seedVersion(scope, { status: 'draft' });
    const sent = await seedVersion(scope, { status: 'sent' });
    // Rendered for real, so it carries a document and a hash.
    const rendered = await seedVersion(scope);
    expect(await sweeper.renderOne(rendered)).toBe('rendered');

    const picked = (await store.candidates(new Date(), 1_000)).map((c) => c.versionId);

    expect(picked).toContain(fresh.versionId);
    expect(picked).toContain(failedLongAgo.versionId);
    expect(picked).toContain(failedTwiceLongAgo.versionId);
    // A dead worker's claim is not taken again as it is: the sweep first counts it as a failed try (below).
    const abandoned = await store.abandoned(new Date(Date.now() - PENDING_STALE_MS), 1_000);
    expect(abandoned.map((c) => c.versionId)).toContain(pendingStale.versionId);
    expect(abandoned.map((c) => c.versionId)).not.toContain(pendingRecently.versionId);
    for (const never of [
      pendingStale,
      failedRecently,
      failedTwiceRecently,
      givenUp,
      pendingRecently,
      draft,
      sent,
      rendered,
    ]) {
      expect(picked).not.toContain(never.versionId);
    }
  });
});

describe('quotation render', () => {
  it('renders an approved version into one document that is clean at once, with no scan', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);

    expect(await sweeper.renderOne(v)).toBe('rendered');

    const row = await versionRow(v.versionId);
    // The render moves only the render columns: the version is still the approved one.
    expect(row.status).toBe('approved');
    expect(row.render_state).toBe('rendered');
    expect(row.rendered_sha256).toHaveLength(32);
    expect(row.rendered_sha256?.toString('hex')).toBe(PDF_SHA256);

    const docs = await documentRows(v.versionId);
    expect(docs).toHaveLength(1);
    const doc = first(docs);
    expect(row.rendered_document_id).toBe(doc.document_id);
    // The document version carries the same hash as the version row, and no user is behind it.
    expect(doc.sha256?.toString('hex')).toBe(PDF_SHA256);
    expect(doc.sha256?.equals(row.rendered_sha256 ?? Buffer.alloc(0))).toBe(true);
    expect(doc.uploaded_by).toBeNull();
    expect(doc.removed_at).toBeNull();

    // The Gotenberg request carried the quotation, and the system path never asked the request's authz.
    expect(gotenberg.requests).toHaveLength(1);
    expect(first(gotenberg.requests)).toContain(v.number);
    expect(first(gotenberg.requests)).toContain('Himal Traders Pvt. Ltd.');
    expect(authz.assert).not.toHaveBeenCalled();

    // Generated bytes skip the virus scan (D28): clean at once, no scan job, and a stray scan job is a no-op.
    expect(doc.status).toBe('clean');
    expect(doc.current_version_id).toBe(doc.version_id);
    expect(queue.add).not.toHaveBeenCalled();
    expect(await processor.scanVersion(scanJob(scope, doc.version_id), true)).toBe('skipped');
  });

  it('keeps the approved content frozen while the render columns move', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);
    expect(await sweeper.renderOne(v)).toBe('rendered');

    // The trigger that let the render through still refuses a change to what was approved.
    await expect(
      pool.query(
        `UPDATE app.quotation_versions SET scope = 'changed after approval' WHERE id = $1`,
        [v.versionId],
      ),
    ).rejects.toMatchObject({ constraint: 'quotation_versions_frozen_check' });
  });

  it('a second sweep adds no document', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);

    await sweeper.sweep();
    expect((await versionRow(v.versionId)).render_state).toBe('rendered');
    const requestsAfterFirst = gotenberg.requests.length;
    expect(await documentRows(v.versionId)).toHaveLength(1);

    await sweeper.sweep();
    expect(await documentRows(v.versionId)).toHaveLength(1);
    expect(gotenberg.requests).toHaveLength(requestsAfterFirst);
  });

  it('two renders at once give one rendered and one skipped, and one document', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);

    const outcomes = await Promise.all([sweeper.renderOne(v), sweeper.renderOne(v)]);

    expect([...outcomes].sort()).toEqual(['rendered', 'skipped']);
    expect(await documentRows(v.versionId)).toHaveLength(1);
    expect(gotenberg.requests).toHaveLength(1);
    expect((await versionRow(v.versionId)).render_state).toBe('rendered');
  });

  it('marks the version failed, with no document, when Gotenberg answers 500', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);
    gotenberg.mode = 'error';

    expect(await sweeper.renderOne(v)).toBe('failed');

    const row = await versionRow(v.versionId);
    expect(row.render_state).toBe('failed');
    expect(row.rendered_document_id).toBeNull();
    expect(row.rendered_sha256).toBeNull();
    expect(await documentRows(v.versionId)).toHaveLength(0);
    expect(gotenberg.requests).toHaveLength(1);
  });

  it('marks the version failed, before any call to Gotenberg, when entity.address is unset', async () => {
    const scope = await newScope({ issuer: false });
    const v = await seedVersion(scope);

    expect(await sweeper.renderOne(v)).toBe('failed');

    expect((await versionRow(v.versionId)).render_state).toBe('failed');
    expect(await documentRows(v.versionId)).toHaveLength(0);
    expect(gotenberg.requests).toHaveLength(0);
  });

  it('adds no document to a version that leaves approved while its PDF is being drawn', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);
    const real = new GotenbergClient(gotenbergUrl, { timeoutMs: 10_000, maxBytes: 1_000_000 });
    const leaving = makeSweeper({
      htmlToPdf: async (html) => {
        // Between the claim and the file: the version is superseded by a revision.
        await withTx(db, scope, seedActor(), (tx) =>
          tx.execute(
            sql`UPDATE app.quotation_versions SET status = 'superseded' WHERE id = ${v.versionId}::uuid`,
          ),
        );
        return real.htmlToPdf(html);
      },
    });

    expect(await leaving.renderOne(v)).toBe('failed');

    const row = await versionRow(v.versionId);
    expect(row.status).toBe('superseded');
    expect(row.render_state).toBe('failed');
    expect(row.rendered_document_id).toBeNull();
    expect(await documentRows(v.versionId)).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('a render that keeps failing (R4c2: TR-Q4, F1-Q13)', () => {
  async function actions(scope: TxScope, quotationId: string): Promise<string[]> {
    const events = await renderAudit.list(scope, {
      entityType: 'quotations',
      entityId: quotationId,
      limit: 100,
    });
    return events.map((e) => e.action).filter((a) => a.startsWith('quotation.pdf_'));
  }
  /** Moves the version's last change back past any pause, so it is due again now. */
  async function waitOutPause(scope: TxScope, versionId: string): Promise<void> {
    await withTx(db, scope, seedActor(), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET updated_at = now() - interval '1 day'
             WHERE id = ${versionId}::uuid`,
      ),
    );
  }

  it('counts each failure, gives up at the limit with one admin entry, and is never taken again', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);
    gotenberg.mode = 'error';

    for (let n = 1; n <= MAX_RENDER_ATTEMPTS; n += 1) {
      expect(await sweeper.renderOne(v)).toBe('failed');
      const row = await versionRow(v.versionId);
      expect(row).toMatchObject({ render_state: 'failed', render_attempts: n });
      const ids = (await store.candidates(new Date(), 1_000)).map((c) => c.versionId);
      // Held back during its pause; due after it while tries are left.
      expect(ids).not.toContain(v.versionId);
      await waitOutPause(scope, v.versionId);
      const due = (await store.candidates(new Date(), 1_000)).map((c) => c.versionId);
      if (n < MAX_RENDER_ATTEMPTS) {
        expect(due).toContain(v.versionId);
        expect(await actions(scope, row.quotation_id)).toEqual([]);
      } else {
        expect(due).not.toContain(v.versionId);
      }
    }
    const { quotation_id: quotationId } = await versionRow(v.versionId);
    expect(await actions(scope, quotationId)).toEqual(['quotation.pdf_render_failed']);
    // Given up: the claim refuses it, so it cannot fail again or write a second entry.
    expect(await sweeper.renderOne(v)).toBe('skipped');
    expect((await versionRow(v.versionId)).render_attempts).toBe(MAX_RENDER_ATTEMPTS);
    expect(await actions(scope, quotationId)).toEqual(['quotation.pdf_render_failed']);
  });

  it('counts a claim left by a dead worker as a failed try, and gives it up at the limit', async () => {
    const scope = await newScope();
    // A worker took the version and died mid-render, on the last try; another one took it and died too.
    const lastTry = await seedVersion(scope, {
      renderState: 'pending',
      renderAttempts: MAX_RENDER_ATTEMPTS - 1,
      idleMs: PENDING_STALE_MS + 60_000,
    });
    const firstTry = await seedVersion(scope, {
      renderState: 'pending',
      idleMs: PENDING_STALE_MS + 60_000,
    });
    // A live claim: its worker is still drawing the PDF.
    const live = await seedVersion(scope, {
      renderState: 'pending',
      renderAttempts: 1,
      idleMs: PENDING_STALE_MS - 60_000,
    });

    const result = await sweeper.sweep();
    expect(result.failures).toEqual(
      expect.arrayContaining([
        { versionId: lastTry.versionId, kind: 'abandoned' },
        { versionId: firstTry.versionId, kind: 'abandoned' },
      ]),
    );
    expect(result.failures.map((f) => f.versionId)).not.toContain(live.versionId);
    // Nothing was drawn for them in this sweep: each waits its pause, like any failure.
    expect(gotenberg.requests).toHaveLength(0);

    const givenUp = await versionRow(lastTry.versionId);
    expect(givenUp).toMatchObject({ render_state: 'failed', render_attempts: MAX_RENDER_ATTEMPTS });
    expect(await actions(scope, givenUp.quotation_id)).toEqual(['quotation.pdf_render_failed']);
    const counted = await versionRow(firstTry.versionId);
    expect(counted).toMatchObject({ render_state: 'failed', render_attempts: 1 });
    expect(await actions(scope, counted.quotation_id)).toEqual([]);
    expect(await versionRow(live.versionId)).toMatchObject({
      render_state: 'pending',
      render_attempts: 1,
    });

    // The given-up one is never taken again; the other is retried after its pause.
    await waitOutPause(scope, lastTry.versionId);
    await waitOutPause(scope, firstTry.versionId);
    const due = (await store.candidates(new Date(), 1_000)).map((c) => c.versionId);
    expect(due).not.toContain(lastTry.versionId);
    expect(due).toContain(firstTry.versionId);
    expect(await sweeper.renderOne(lastTry)).toBe('skipped');
    expect(await actions(scope, givenUp.quotation_id)).toEqual(['quotation.pdf_render_failed']);
  });

  it('resets the attempts when a later try renders', async () => {
    const scope = await newScope();
    const v = await seedVersion(scope);
    gotenberg.mode = 'error';
    expect(await sweeper.renderOne(v)).toBe('failed');
    expect((await versionRow(v.versionId)).render_attempts).toBe(1);
    await waitOutPause(scope, v.versionId);
    gotenberg.mode = 'ok';
    expect(await sweeper.renderOne(v)).toBe('rendered');
    expect(await versionRow(v.versionId)).toMatchObject({
      render_state: 'rendered',
      render_attempts: 0,
    });
  });
});

describe('orphan generated documents', () => {
  it('soft-removes an orphan older than an hour and keeps a younger one', async () => {
    const scope = await newScope();
    // `pending` and just touched, so neither version is a render candidate: only the orphan cleanup acts.
    const oldOwner = await seedVersion(scope, { renderState: 'pending', idleMs: 0 });
    const youngOwner = await seedVersion(scope, { renderState: 'pending', idleMs: 0 });
    const oldDoc = await createOrphan(scope, oldOwner.versionId, ORPHAN_AFTER_MS + 5 * 60_000);
    const youngDoc = await createOrphan(scope, youngOwner.versionId, ORPHAN_AFTER_MS - 30 * 60_000);

    const result = await sweeper.sweep();

    expect(result.orphansRemoved).toBeGreaterThanOrEqual(1);
    const removedAt = async (versionId: string, documentId: string) =>
      first((await documentRows(versionId)).filter((d) => d.document_id === documentId)).removed_at;
    expect(await removedAt(oldOwner.versionId, oldDoc)).not.toBeNull();
    expect(await removedAt(youngOwner.versionId, youngDoc)).toBeNull();
  });
});
