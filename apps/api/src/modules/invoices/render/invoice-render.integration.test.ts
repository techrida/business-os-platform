// The invoice render sweeper and the document route against real Postgres (P3 unit U11). The real store, the real
// GotenbergClient talking over HTTP to a fake Gotenberg (a node:http server that answers one fixed PDF), the real
// DocumentsService on a temp dir with the real InvoiceOwnerPolicy registered as `invoice`, and the real ScanProcessor
// against the fake clamd. Fakes: authz (it must never be called on the system path), audit, the scan queue, and the
// request context of the route.
//
// Issued invoices are frozen (invoices_guard), so a test cannot retire one the way the quotation test does. Every test
// drives `renderOne` and asserts on its own invoice id; the one test that calls `sweep()` asserts only on its own rows.
//
// What it holds:
//   * done check 1: the golden invoice (1,880,000.00 less 5%, VAT 13%) reaches Gotenberg printing `NPR 20,18,180.00`,
//     titled "Tax Invoice" with the seller's PAN; a proforma prints "Proforma Invoice";
//   * the PDF is stored as a generated document owned by the invoice and is `clean` at once: it skips the virus
//     scan (D28), so no scan job is queued; print 1 is logged with no user, and the invoice row itself is untouched;
//   * a reprint (the original's document removed) prints "Copy of original (1)" as print 2;
//   * candidates: issued tax invoices and proformas without a live document, never drafts or rendered ones;
//   * two renders at once give one document and one print; Gotenberg 500 and a draft leave no document and no print;
//   * an orphan generated document older than 1 h is soft-removed by a sweep, a younger one is kept;
//   * GET /v1/invoices/:id/document: a link for the clean PDF right after the render; 404 for a draft, for another entity
//     and for a random id; 403 for a portal caller.
//
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/render/invoice-render.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createTenantWithEntity, runMigrations } from '@bos/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
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
import { GotenbergClient } from '../../quotations/render/gotenberg.client';
import type { RunInTx } from '../../quotations/render/quotation-render.sweeper';
import {
  drizzleInvoiceHeadLoader,
  INVOICE_OWNER_TYPE,
  INVOICE_RENDER_JOB_PREFIX,
  InvoiceOwnerPolicy,
} from '../invoice-owner.policy';
import { InvoiceDocumentService } from './invoice-document.service';
import {
  drizzleInvoiceRenderStore,
  FAILED_RETRY_MS,
  InvoiceRenderSweeper,
  ORPHAN_AFTER_MS,
  type RenderCandidate,
} from './invoice-render.sweeper';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const PAN = '301234567';

// What the fake Gotenberg answers: a small, valid-looking PDF, always the same bytes.
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
  Buffer.alloc(200, 0x20),
]);

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

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let storageRoot: string;
let storage: DiskStorageAdapter;
let documents: DocumentsService;
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let gotenbergServer: Server;
let sweeper: InvoiceRenderSweeper;
let store: ReturnType<typeof drizzleInvoiceRenderStore>;
let service: InvoiceDocumentService;

const gotenberg = { mode: 'ok' as 'ok' | 'error', requests: [] as string[] };
const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };
// The render reads only `format.number_system`; NPR documents group the same under the default.
const settings = { get: vi.fn().mockResolvedValue('south_asian') };

const runTx: RunInTx = (scope, actor, fn) => withTx(db, scope, actor, fn);
const seedActor = () => systemActor('invoice-render-test-seed');
const renderActor = () => systemActor(INVOICE_RENDER_JOB_PREFIX);

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The caller of the route; each test sets it. */
const current: { scope: TxScope; orgKind: Principal['orgKind'] } = {
  scope: { tenantId: '', organizationId: '' },
  orgKind: 'staff',
};
const caller = {
  current: () => ({
    scope: current.scope,
    actor: systemActor('invoice-document-test'),
    principal: {
      userId: randomUUID(),
      zitadelUserId: 'z-test',
      ...current.scope,
      orgKind: current.orgKind,
      partyId: null,
      idpOrgId: 'unused',
      roles: [],
      departmentId: null,
      status: 'active',
      grants: grantsOf('accountant'),
    } satisfies Principal,
  }),
};

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
  const gotenbergUrl = `http://127.0.0.1:${(gotenbergServer.address() as AddressInfo).port}`;

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-invoice-render-'));
  storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  // The real policy of an invoice, as the worker module registers it.
  documents.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(db)));
  store = drizzleInvoiceRenderStore(db);

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
  service = new InvoiceDocumentService(db, documents, caller);
});

afterAll(async () => {
  await fakeClamd?.close();
  gotenbergServer?.closeAllConnections();
  await new Promise<void>((resolve) =>
    gotenbergServer ? gotenbergServer.close(() => resolve()) : resolve(),
  );
  await pool?.end();
  await container?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  gotenberg.mode = 'ok';
  gotenberg.requests.length = 0;
  authz.assert.mockReset();
  audit.record.mockClear();
  queue.add.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------------------- helpers

function makeSweeper(pdf: GotenbergClient): InvoiceRenderSweeper {
  return new InvoiceRenderSweeper(store, runTx, documents, settings, pdf, () => new Date());
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

/** A tenant with its default entity, a tax code and a customer. */
async function newScope(): Promise<TestScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  const scope = { tenantId, organizationId };
  const { partyId } = await createParty(pool, { tenantId, kind: 'customer' });
  const taxCodeId = await withTx(db, scope, seedActor(), async (tx) => {
    await tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
      VALUES (${partyId}::uuid, ${tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              'Himal Traders Pvt. Ltd.', 'himal traders', '{"line1":"Thamel 4","country":"NP"}'::jsonb)`);
    const taxCode = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
      VALUES (${tenantId}::uuid, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`);
    return first(taxCode.rows).id;
  });
  return { ...scope, customerId: partyId, taxCodeId };
}

let seq = 0;

interface SeedOptions {
  kind?: 'tax_invoice' | 'proforma';
  /** `draft` leaves the invoice unissued: no number, no snapshots. */
  status?: 'draft' | 'issued';
  issuedAt?: Date;
}

interface Seeded extends RenderCandidate {
  number: string | null;
}

/**
 * The golden invoice of P3 done check 1 (subtotal 1,880,000.00, discount 94,000.00, taxable 1,786,000.00, VAT
 * 232,180.00, total 2,018,180.00), written the way the app does: as a draft with its lines, then issued in one UPDATE.
 */
async function seedInvoice(scope: TestScope, options: SeedOptions = {}): Promise<Seeded> {
  const kind = options.kind ?? 'tax_invoice';
  const status = options.status ?? 'issued';
  const n = (seq += 1);
  const number = `${kind === 'proforma' ? 'PI' : 'INV'}-2083/84-${String(n).padStart(5, '0')}`;
  const { tenantId, organizationId } = scope;
  const invoiceId = await withTx(db, scope, seedActor(), async (tx) => {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.invoices
        (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency, subtotal,
         discount_amount, taxable_vat_amount, total, tax_amount, due_date)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${kind}, ${scope.customerId}::uuid,
              ${kind === 'tax_invoice' ? 'integration test' : null}, 'NPR', 1880000, 94000, 1786000,
              2018180, 232180, '2026-12-09') RETURNING id`);
    const id = first(inserted.rows).id;
    await tx.execute(sql`
      INSERT INTO app.invoice_lines
        (tenant_id, organization_id, invoice_id, line_no, description, uom, quantity, unit_price,
         tax_code_id, gross, discount_alloc, taxable)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${id}::uuid, 1, 'Solar panel array', 'set', 1,
              1880000, ${scope.taxCodeId}::uuid, 1880000, 94000, 1786000)`);
    await tx.execute(sql`
      INSERT INTO app.invoice_tax_summary
        (tenant_id, organization_id, invoice_id, tax_code_id, label, rate, base, tax)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${id}::uuid, ${scope.taxCodeId}::uuid,
              'VAT 13%', 13, 1786000, 232180)`);
    if (status === 'issued') {
      const seller = { legalName: 'Techrida Pvt. Ltd.', panVatNo: PAN, address: 'Durbar Marg 1' };
      const buyer = {
        legalName: 'Himal Traders Pvt. Ltd.',
        panVatNo: 'ABC-12345',
        address: 'Thamel 4',
      };
      await tx.execute(sql`
        UPDATE app.invoices
           SET status = 'issued', number = ${number}, seq = ${n}, fiscal_year = '2083/84',
               issue_date = '2026-11-09', issue_date_bs = '2083-07-24',
               issued_at = coalesce(${options.issuedAt?.toISOString() ?? null}::timestamptz, now()),
               fx_rate = 1, amount_npr = total,
               seller_snapshot = ${JSON.stringify(seller)}::jsonb,
               buyer_snapshot = ${JSON.stringify(buyer)}::jsonb,
               content_hash = decode(repeat('ab', 32), 'hex')
         WHERE id = ${id}::uuid`);
    }
    return id;
  });
  return { tenantId, organizationId, invoiceId, number: status === 'issued' ? number : null };
}

async function documentRows(invoiceId: string) {
  const { rows } = await pool.query<{
    document_id: string;
    removed_at: Date | null;
    version_id: string;
    filename: string;
    status: string;
    uploaded_by: string | null;
  }>(
    `SELECT d.id AS document_id, d.removed_at, v.id AS version_id, v.filename, v.status, v.uploaded_by
       FROM app.documents d JOIN app.document_versions v ON v.document_id = d.id
      WHERE d.owner_type = $1 AND d.owner_id = $2 ORDER BY d.created_at`,
    [INVOICE_OWNER_TYPE, invoiceId],
  );
  return rows;
}

async function printRows(invoiceId: string) {
  const { rows } = await pool.query<{ print_no: number; printed_by: string | null }>(
    'SELECT print_no, printed_by FROM app.invoice_print_log WHERE invoice_id = $1 ORDER BY print_no',
    [invoiceId],
  );
  return rows;
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await pool.query<{ version: number; updated_at: Date; status: string }>(
    'SELECT version, updated_at, status FROM app.invoices WHERE id = $1',
    [invoiceId],
  );
  return first(rows);
}

const scanJob = (scope: TxScope, versionId: string) => ({
  versionId,
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
});

/** An orphan: a generated document created for the invoice and never given its bytes. */
async function createOrphan(scope: TestScope, invoiceId: string, ageMs: number): Promise<string> {
  const file: GeneratedFile = {
    filename: 'orphan.pdf',
    declaredMime: 'application/pdf',
    bytes: PDF,
  };
  const created = await withTx(db, scope, renderActor(), (tx: DbTransaction) =>
    documents.createGenerated(tx, { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId }, file),
  );
  await withTx(db, scope, seedActor(), (tx) =>
    tx.execute(
      sql`UPDATE app.documents SET created_at = ${new Date(Date.now() - ageMs).toISOString()}::timestamptz
           WHERE id = ${created.documentId}::uuid`,
    ),
  );
  return created.documentId;
}

/** Renders the invoice; the generated PDF is clean at once (D28), with no scan to wait for. */
async function renderClean(inv: Seeded): Promise<void> {
  expect(await sweeper.renderOne(inv)).toBe('rendered');
  expect(first(await documentRows(inv.invoiceId)).status).toBe('clean');
}

// ------------------------------------------------------------------------------------------- tests

describe('invoice render', () => {
  it('reaches newer pending invoices past multiple failing batches and wraps after a rendered cursor', async () => {
    const scope = await newScope();
    const issuedAt = new Date('2026-11-09T06:00:00Z');
    const failed: RenderCandidate[] = [];
    for (let i = 0; i < 25; i += 1) {
      failed.push(await seedInvoice(scope, { issuedAt }));
    }
    const healthy = await seedInvoice(scope, { issuedAt: new Date(issuedAt.getTime() + 1_000) });
    const fairStore = drizzleInvoiceRenderStore(db);
    const load = vi.spyOn(fairStore, 'load');
    let clock = issuedAt;
    const pdf = {
      htmlToPdf: vi.fn((html: string) => {
        if (html.includes(healthy.number ?? 'missing invoice')) return Promise.resolve(PDF);
        return Promise.reject(new Error('permanent render failure'));
      }),
    };
    const worker = new InvoiceRenderSweeper(
      fairStore,
      runTx,
      documents,
      settings,
      pdf,
      () => clock,
    );

    // Every retry has expired before the next tick. The oldest-first query used to pick the same ten forever.
    for (let tick = 0; tick < 3; tick += 1) {
      await worker.sweep();
      clock = new Date(clock.getTime() + FAILED_RETRY_MS + 1);
    }
    expect(await documentRows(healthy.invoiceId)).toHaveLength(1);
    expect(await printRows(healthy.invoiceId)).toEqual([{ print_no: 1, printed_by: null }]);
    expect(new Set(load.mock.calls.map(([, c]) => c.invoiceId))).toEqual(
      new Set([...failed, healthy].map((c) => c.invoiceId)),
    );
    expect(await Promise.all(failed.map((c) => printRows(c.invoiceId)))).toEqual(
      failed.map(() => []),
    );

    // Rendering the cursor's document must not invalidate its position. Equal issue timestamps use id order.
    load.mockClear();
    await worker.sweep();
    const { rows: oldest } = await pool.query<{ id: string }>(
      'SELECT id FROM app.invoices WHERE id = ANY($1::uuid[]) ORDER BY issued_at, id LIMIT 10',
      [failed.map((c) => c.invoiceId)],
    );
    expect(load.mock.calls.map(([, c]) => c.invoiceId)).toEqual(oldest.map((r) => r.id));
    expect((await fairStore.candidates(10, [], randomUUID())).map((c) => c.invoiceId)).toEqual(
      oldest.map((r) => r.id),
    );
  });

  it('renders its invoice without depending on the global sweep batch', async () => {
    const older = await newScope();
    for (let i = 0; i < 10; i += 1) await seedInvoice(older);
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const batch = await store.candidates(10, []);
    expect(batch).toHaveLength(10);
    expect(batch.some((candidate) => candidate.invoiceId === inv.invoiceId)).toBe(false);

    // A journey needs its own PDF even when another fixture has a full batch pending.
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    const docs = await documentRows(inv.invoiceId);
    expect(docs).toHaveLength(1);
    expect(first(docs).status).toBe('clean');
  });

  it('prints the golden invoice as NPR 20,18,180.00 and stores a clean PDF owned by the invoice', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const before = await invoiceRow(inv.invoiceId);

    expect(await sweeper.renderOne(inv)).toBe('rendered');

    // Done check 1: what Chromium was asked to print.
    expect(gotenberg.requests).toHaveLength(1);
    const html = first(gotenberg.requests);
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('Tax Invoice');
    expect(html).toContain(inv.number ?? 'missing');
    expect(html).toContain(`PAN/VAT ${PAN}`);
    expect(html).toContain('2083-07-24 BS');
    expect(html).not.toContain('Copy of original');
    expect(authz.assert).not.toHaveBeenCalled();

    // One generated document, owned by the invoice, with no user behind it, named for the number.
    const docs = await documentRows(inv.invoiceId);
    expect(docs).toHaveLength(1);
    const doc = first(docs);
    expect(doc.uploaded_by).toBeNull();
    expect(doc.removed_at).toBeNull();
    expect(doc.filename).toBe(`${(inv.number ?? '').replaceAll('/', '-')}.pdf`);
    // Generated bytes skip the virus scan (D28): clean at once, no scan job, and a stray scan job is a no-op.
    expect(doc.status).toBe('clean');
    expect(queue.add).not.toHaveBeenCalled();
    expect(await processor.scanVersion(scanJob(scope, doc.version_id), true)).toBe('skipped');

    // Print 1 is logged, by no one; the frozen invoice row did not move.
    expect(await printRows(inv.invoiceId)).toEqual([{ print_no: 1, printed_by: null }]);
    const after = await invoiceRow(inv.invoiceId);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('prints a proforma as a Proforma Invoice', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope, { kind: 'proforma' });
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    const html = first(gotenberg.requests);
    expect(html).toContain('Proforma Invoice');
    expect(html).toContain('not a tax invoice');
    expect(html).not.toContain('<h1>Tax Invoice</h1>');
  });

  it('prints a reprint as "Copy of original (1)", print 2, in its own file', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    // The original's document is taken away; the invoice has none again, but the log remembers print 1.
    await withTx(db, scope, seedActor(), (tx) =>
      tx.execute(
        sql`UPDATE app.documents SET removed_at = now() WHERE owner_type = 'invoice' AND owner_id = ${inv.invoiceId}::uuid`,
      ),
    );
    gotenberg.requests.length = 0;

    expect(await sweeper.renderOne(inv)).toBe('rendered');

    expect(first(gotenberg.requests)).toContain('Copy of original (1)');
    const live = (await documentRows(inv.invoiceId)).filter((d) => d.removed_at === null);
    expect(live.map((d) => d.filename)).toEqual([
      `${(inv.number ?? '').replaceAll('/', '-')}-copy1.pdf`,
    ]);
    expect((await printRows(inv.invoiceId)).map((p) => p.print_no)).toEqual([1, 2]);
  });

  it('picks issued tax invoices and proformas without a live document, nothing else', async () => {
    const scope = await newScope();
    const fresh = await seedInvoice(scope);
    const proforma = await seedInvoice(scope, { kind: 'proforma' });
    const draft = await seedInvoice(scope, { status: 'draft' });
    const rendered = await seedInvoice(scope);
    expect(await sweeper.renderOne(rendered)).toBe('rendered');

    const picked = (await store.candidates(1_000, [])).map((c) => c.invoiceId);

    expect(picked).toContain(fresh.invoiceId);
    expect(picked).toContain(proforma.invoiceId);
    expect(picked).not.toContain(draft.invoiceId);
    expect(picked).not.toContain(rendered.invoiceId);
    expect(
      (await store.candidates(1_000, [fresh.invoiceId])).map((c) => c.invoiceId),
    ).not.toContain(fresh.invoiceId);
  });

  it('two renders at once give one document and one print', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);

    const outcomes = await Promise.all([sweeper.renderOne(inv), sweeper.renderOne(inv)]);

    expect([...outcomes].sort()).toEqual(['rendered', 'skipped']);
    expect(await documentRows(inv.invoiceId)).toHaveLength(1);
    expect(await printRows(inv.invoiceId)).toHaveLength(1);
  });

  it('leaves no document and no print when Gotenberg fails, and renders on the next try', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    gotenberg.mode = 'error';

    expect(await sweeper.renderOne(inv)).toBe('failed');
    expect(await documentRows(inv.invoiceId)).toHaveLength(0);
    expect(await printRows(inv.invoiceId)).toHaveLength(0);

    gotenberg.mode = 'ok';
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    expect(await documentRows(inv.invoiceId)).toHaveLength(1);
    expect((await printRows(inv.invoiceId)).map((p) => p.print_no)).toEqual([1]);
  });

  it('refuses a draft: it is not rendered and gets no document', async () => {
    const scope = await newScope();
    const draft = await seedInvoice(scope, { status: 'draft' });
    expect(await sweeper.renderOne(draft)).toBe('failed');
    expect(gotenberg.requests).toHaveLength(0);
    expect(await documentRows(draft.invoiceId)).toHaveLength(0);
    // And the owner policy itself refuses the render job for a draft.
    await expect(
      withTx(db, scope, renderActor(), (tx) =>
        documents.createGenerated(
          tx,
          { ownerType: INVOICE_OWNER_TYPE, ownerId: draft.invoiceId },
          { filename: 'x.pdf', declaredMime: 'application/pdf', bytes: PDF },
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removes an orphan older than an hour and keeps a younger one', async () => {
    const scope = await newScope();
    const old = await seedInvoice(scope);
    const young = await seedInvoice(scope);
    const oldDoc = await createOrphan(scope, old.invoiceId, ORPHAN_AFTER_MS + 60_000);
    const youngDoc = await createOrphan(scope, young.invoiceId, ORPHAN_AFTER_MS - 60_000);

    const result = await sweeper.sweep();

    expect(result.orphansRemoved).toBeGreaterThanOrEqual(1);
    const removed = async (documentId: string) =>
      (
        await pool.query<{ removed_at: Date | null }>(
          'SELECT removed_at FROM app.documents WHERE id = $1',
          [documentId],
        )
      ).rows[0]?.removed_at;
    expect(await removed(oldDoc)).not.toBeNull();
    expect(await removed(youngDoc)).toBeNull();
  });
});

describe('GET /v1/invoices/:id/document', () => {
  const asStaff = (scope: TxScope) => {
    current.scope = scope;
    current.orgKind = 'staff';
  };

  it('links the clean PDF right after the render, with no scan in between', async () => {
    const scope = await newScope();
    asStaff(scope);
    const inv = await seedInvoice(scope);
    // Not rendered yet: nothing to serve.
    await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await sweeper.renderOne(inv)).toBe('rendered');

    const link = await service.link(inv.invoiceId);
    expect(link.url.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(link.expiresAt))).toBe(false);
  });

  it('is a 404 for a draft, for another entity, for a random id and before any render', async () => {
    const scope = await newScope();
    const other = await newScope();
    const draft = await seedInvoice(scope, { status: 'draft' });
    const unrendered = await seedInvoice(scope);
    const issued = await seedInvoice(scope);
    await renderClean(issued);

    asStaff(scope);
    await expect(service.link(draft.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(unrendered.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(issued.invoiceId)).resolves.toBeDefined();

    // Another legal entity of another tenant cannot see it, and the answer is the same 404.
    asStaff(other);
    await expect(service.link(issued.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 403 for a portal caller', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    await renderClean(inv);
    current.scope = scope;
    current.orgKind = 'customer';
    await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
