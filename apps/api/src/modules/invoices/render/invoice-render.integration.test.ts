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
//   * print 1 stores the number grouping and date pattern it printed with (`render_format`);
//   * a reprint (the original's document removed) prints "Copy of original (1)" as print 2, with print 1's grouping
//     and date pattern even after the settings changed; a copy of a print with no stored format uses the settings;
//   * candidates: issued tax invoices and proformas without a live document, never drafts or rendered ones;
//   * two renders at once give one document and one print; Gotenberg 500 and a draft leave no document and no print;
//   * an orphan generated document older than 1 h is soft-removed by a sweep, a younger one is kept;
//   * a stored PDF is never removed when its print row fails: the write is retried once, and a second failure leaves
//     the PDF live with no failure counted and no second original;
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
  DocumentFormatSnapshotSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createTenantWithEntity } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
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
import { NO_DOCUMENT_LOGO_RESOLVER } from '../../quotations/render/issuer';
import type {
  RenderLogos,
  RenderSettings,
  RunInTx,
} from '../../quotations/render/quotation-render.sweeper';
import { MAX_RENDER_ATTEMPTS, RETRY_PAUSE_MAX_MS } from '../../quotations/render/render-retry';
import {
  drizzleInvoiceHeadLoader,
  INVOICE_OWNER_TYPE,
  INVOICE_RENDER_JOB_PREFIX,
  InvoiceOwnerPolicy,
} from '../invoice-owner.policy';
import { InvoiceIssueService } from '../invoice-issue.service';
import { LedgerService } from '../../ledger/ledger.service';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import type { SettingsService } from '../../../platform/settings/settings.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { InvoiceDocumentService } from './invoice-document.service';
import { INVOICE_RENDER_ONE_JOB, InvoiceRenderNudge } from './invoice-render.nudge';
import {
  drizzleInvoiceRenderStore,
  InvoiceRenderProcessor,
  InvoiceRenderSweeper,
  ORPHAN_AFTER_MS,
  type RenderCandidate,
  type RenderStore,
} from './invoice-render.sweeper';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

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

let testDb: TestDatabase;
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
/** The real audit trail: a given-up render and a Retry must write their entries. */
let renderAudit: AuditService;

const gotenberg = { mode: 'ok' as 'ok' | 'error', requests: [] as string[] };
const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };
// The render reads `format.number_systems` and `format.date`. These are the defaults; a test that changes them
// puts them back with `resetSettings`.
const DEFAULT_SETTINGS: Record<string, unknown> = {
  'format.number_systems': { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
  'format.date': 'dd MMM yyyy',
};
const liveSettings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
const resetSettings = () => Object.assign(liveSettings, DEFAULT_SETTINGS);
/** No logo document resolves here: the logo freeze is covered by the sweeper's unit tests. */
const NO_LOGOS: RenderLogos = { forScope: () => NO_DOCUMENT_LOGO_RESOLVER };
const settings = {
  get: vi.fn((_scope: TxScope, key: string) => Promise.resolve(liveSettings[key])),
} as unknown as RenderSettings;

const runTx: RunInTx = (scope, actor, fn) => withTx(db, scope, actor, fn);
const seedActor = () => systemActor('invoice-render-test-seed');
const renderActor = () => systemActor(INVOICE_RENDER_JOB_PREFIX);

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The caller of the route; each test sets it. */
const current: { scope: TxScope; orgKind: Principal['orgKind']; role: RoleKey } = {
  scope: { tenantId: '', organizationId: '' },
  orgKind: 'staff',
  role: 'accountant',
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
      grants: grantsOf(current.role),
    } satisfies Principal,
  }),
};

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
  service = new InvoiceDocumentService(db, documents, caller, renderAudit, retryNudge as never);
});

const retryNudge = { nudge: vi.fn().mockResolvedValue(undefined) };

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
  resetSettings();
  current.role = 'accountant';
});

// ---------------------------------------------------------------------------------------- helpers

function makeSweeper(pdf: GotenbergClient): InvoiceRenderSweeper {
  return new InvoiceRenderSweeper(
    store,
    runTx,
    documents,
    settings,
    pdf,
    () => new Date(),
    NO_LOGOS,
    renderAudit,
  );
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
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
      VALUES (${partyId}::uuid, ${tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
              'Himal Traders Pvt. Ltd.', 'himal traders', 'NP', 'Thamel 4', 'Kathmandu')`);
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

/** Each print's stored `render_format`, by print number. Kept apart from printRows so its equality checks stay as they are. */
async function printFormats(invoiceId: string) {
  const { rows } = await pool.query<{ print_no: number; render_format: unknown }>(
    'SELECT print_no, render_format FROM app.invoice_print_log WHERE invoice_id = $1 ORDER BY print_no',
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
      NO_LOGOS,
      renderAudit,
    );

    // Every pause has expired before the next tick. The oldest-first query used to pick the same ten forever.
    for (let tick = 0; tick < 3; tick += 1) {
      await worker.sweep();
      clock = new Date(clock.getTime() + RETRY_PAUSE_MAX_MS + 1);
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
    // They just failed again, so they wait out their pause first; after it they lead the batch again.
    const afterPause = new Date(clock.getTime() + RETRY_PAUSE_MAX_MS + 1);
    const dueNow = (await fairStore.candidates(clock, 100, randomUUID())).map((c) => c.invoiceId);
    expect(dueNow.filter((id) => oldest.some((r) => r.id === id))).toEqual([]);
    expect(
      (await fairStore.candidates(afterPause, 10, randomUUID())).map((c) => c.invoiceId),
    ).toEqual(oldest.map((r) => r.id));
  });

  it('renders its invoice without depending on the global sweep batch', async () => {
    const older = await newScope();
    for (let i = 0; i < 10; i += 1) await seedInvoice(older);
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const batch = await store.candidates(new Date(), 10);
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
    expect(html).toContain('(24 Kartik 2083 BS)');
    expect(html).not.toContain('2083-07-24');
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
    // ...and it keeps the format it printed with, for any later copy.
    const formats = await printFormats(inv.invoiceId);
    expect(formats.map((p) => p.print_no)).toEqual([1]);
    // What a later copy will read back must parse as a format snapshot.
    const stored = DocumentFormatSnapshotSchema.parse(first(formats).render_format);
    expect(stored).toMatchObject({
      numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
      dateFormat: 'dd MMM yyyy',
    });
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

  it('prints a reprint as "Copy of original (1)", print 2, in its own file, formatted like print 1', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    expect(first(gotenberg.requests)).toContain('NPR 20,18,180.00');
    expect(first(gotenberg.requests)).toContain('09 Nov 2026');
    // The company changes its grouping and date pattern after the original went out.
    liveSettings['format.number_systems'] = {
      NPR: 'international',
      INR: 'international',
      USD: 'international',
    };
    liveSettings['format.date'] = 'dd/MM/yyyy';
    // The original's document is taken away; the invoice has none again, but the log remembers print 1.
    await withTx(db, scope, seedActor(), (tx) =>
      tx.execute(
        sql`UPDATE app.documents SET removed_at = now() WHERE owner_type = 'invoice' AND owner_id = ${inv.invoiceId}::uuid`,
      ),
    );
    gotenberg.requests.length = 0;

    expect(await sweeper.renderOne(inv)).toBe('rendered');

    const copy = first(gotenberg.requests);
    expect(copy).toContain('Copy of original (1)');
    // Print 1's stored format, not today's settings.
    expect(copy).toContain('NPR 20,18,180.00');
    expect(copy).not.toContain('NPR 2,018,180.00');
    expect(copy).toContain('09 Nov 2026');
    expect(copy).not.toContain('09/11/2026');
    const live = (await documentRows(inv.invoiceId)).filter((d) => d.removed_at === null);
    expect(live.map((d) => d.filename)).toEqual([
      `${(inv.number ?? '').replaceAll('/', '-')}-copy1.pdf`,
    ]);
    expect((await printRows(inv.invoiceId)).map((p) => p.print_no)).toEqual([1, 2]);
    // Only the original stores a format.
    expect((await printFormats(inv.invoiceId)).map((p) => p.render_format === null)).toEqual([
      false,
      true,
    ]);
  });

  it('prints a copy of a print made before render_format existed with the settings in force', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    // Print 1 as a print before migration 0051 left it: logged, no stored format, no live document.
    await withTx(db, scope, seedActor(), (tx) =>
      tx.execute(sql`
        INSERT INTO app.invoice_print_log (tenant_id, organization_id, invoice_id, print_no, printed_by, printed_at)
        VALUES (${scope.tenantId}::uuid, ${scope.organizationId}::uuid, ${inv.invoiceId}::uuid, 1, NULL, now())`),
    );
    liveSettings['format.number_systems'] = {
      NPR: 'international',
      INR: 'international',
      USD: 'international',
    };
    liveSettings['format.date'] = 'dd/MM/yyyy';

    expect(await sweeper.renderOne(inv)).toBe('rendered');

    const copy = first(gotenberg.requests);
    expect(copy).toContain('Copy of original (1)');
    expect(copy).toContain('NPR 2,018,180.00');
    expect(copy).toContain('09/11/2026');
    expect((await printFormats(inv.invoiceId)).map((p) => p.render_format)).toEqual([null, null]);
  });

  it('picks issued tax invoices and proformas without a live document, nothing else', async () => {
    const scope = await newScope();
    const fresh = await seedInvoice(scope);
    const proforma = await seedInvoice(scope, { kind: 'proforma' });
    const draft = await seedInvoice(scope, { status: 'draft' });
    const rendered = await seedInvoice(scope);
    expect(await sweeper.renderOne(rendered)).toBe('rendered');

    const picked = (await store.candidates(new Date(), 1_000)).map((c) => c.invoiceId);

    expect(picked).toContain(fresh.invoiceId);
    expect(picked).toContain(proforma.invoiceId);
    expect(picked).not.toContain(draft.invoiceId);
    expect(picked).not.toContain(rendered.invoiceId);
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

  it('removes an orphan older than ORPHAN_AFTER_MS and keeps a younger one', async () => {
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
    // Not rendered yet: being prepared (409), never a "not found".
    await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(ConflictException);
    expect(await sweeper.renderOne(inv)).toBe('rendered');

    const link = await service.link(inv.invoiceId);
    expect(link.url.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(link.expiresAt))).toBe(false);
  });

  it('is a 404 for a draft, for another entity and for a random id; 409 before any render', async () => {
    const scope = await newScope();
    const other = await newScope();
    const draft = await seedInvoice(scope, { status: 'draft' });
    const unrendered = await seedInvoice(scope);
    const issued = await seedInvoice(scope);
    await renderClean(issued);

    asStaff(scope);
    await expect(service.link(draft.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(unrendered.invoiceId)).rejects.toBeInstanceOf(ConflictException);
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
  /** A document of the invoice whose only upload moved through `statuses` (from awaiting_content). */
  async function documentWith(scope: TestScope, invoiceId: string, statuses: string[]) {
    const documentId = await createOrphan(scope, invoiceId, 0);
    for (const status of statuses) {
      await withTx(db, scope, seedActor(), (tx) =>
        tx.execute(
          sql`UPDATE app.document_versions SET status = ${status} WHERE document_id = ${documentId}::uuid`,
        ),
      );
    }
  }

  const codeOf = async (invoiceId: string) => {
    const refused = await service.link(invoiceId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    const response = (refused as HttpException).getResponse() as { code?: string };
    return { status: (refused as HttpException).getStatus(), code: response.code };
  };

  it('names a PDF the virus scan refused with its own code, apart from a missing one', async () => {
    const scope = await newScope();
    asStaff(scope);
    const infected = await seedInvoice(scope);
    await documentWith(scope, infected.invoiceId, ['quarantined', 'infected']);
    const scanFailed = await seedInvoice(scope);
    await documentWith(scope, scanFailed.invoiceId, ['quarantined', 'scan_failed']);

    expect(await codeOf(infected.invoiceId)).toEqual({
      status: 404,
      code: 'invoice_pdf_scan_refused',
    });
    expect(await codeOf(scanFailed.invoiceId)).toEqual({
      status: 404,
      code: 'invoice_pdf_scan_refused',
    });
  });

  it('reads a live document whose only upload was rejected as being prepared: the render tries again', async () => {
    const scope = await newScope();
    asStaff(scope);
    const inv = await seedInvoice(scope);
    await documentWith(scope, inv.invoiceId, ['quarantined', 'rejected']);
    expect(await codeOf(inv.invoiceId)).toEqual({ status: 409, code: 'invoice_pdf_not_ready' });
  });
});

describe('a render that keeps failing (R4c2: TR-Q4, F1-Q13)', () => {
  const asStaff = (scope: TxScope, role: RoleKey = 'accountant') => {
    current.scope = scope;
    current.orgKind = 'staff';
    current.role = role;
  };
  const ids = (cs: RenderCandidate[]) => cs.map((c) => c.invoiceId);
  async function failureRow(invoiceId: string) {
    const { rows } = await pool.query<{
      attempts: number;
      last_failure_kind: string;
      next_attempt_at: Date | null;
      exhausted_at: Date | null;
    }>(
      `SELECT attempts, last_failure_kind, next_attempt_at, exhausted_at
         FROM app.document_render_failures WHERE owner_type = 'invoice' AND owner_id = $1`,
      [invoiceId],
    );
    return rows[0];
  }
  async function actions(scope: TxScope, invoiceId: string): Promise<string[]> {
    const events = await renderAudit.list(scope, {
      entityType: 'invoices',
      entityId: invoiceId,
      limit: 100,
    });
    return events.map((e) => e.action).filter((a) => a.startsWith('invoice.pdf_'));
  }
  const failingWorker = (clock: () => Date) =>
    new InvoiceRenderSweeper(
      store,
      runTx,
      documents,
      settings,
      { htmlToPdf: vi.fn().mockRejectedValue(new Error('chromium gone')) },
      clock,
      NO_LOGOS,
      renderAudit,
    );

  it('retries with a growing pause, then gives up with one admin entry and a 424; Retry by an issuer starts again', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    asStaff(scope);
    let clock = new Date();
    const worker = failingWorker(() => clock);

    let previousPause = 0;
    for (let n = 1; n <= MAX_RENDER_ATTEMPTS; n += 1) {
      expect(await worker.renderOne(inv)).toBe('failed');
      const row = await failureRow(inv.invoiceId);
      expect(row).toMatchObject({ attempts: n, last_failure_kind: 'error' });
      if (n === MAX_RENDER_ATTEMPTS) break;
      // Still being tried: held back during its pause, due after it, and the screen reads "being prepared".
      expect(row?.exhausted_at).toBeNull();
      const due = row?.next_attempt_at ?? new Date(0);
      const pause = due.getTime() - clock.getTime();
      expect(pause).toBeGreaterThan(previousPause);
      previousPause = pause;
      expect(ids(await store.candidates(clock, 1_000))).not.toContain(inv.invoiceId);
      clock = new Date(due.getTime() + 1);
      expect(ids(await store.candidates(clock, 1_000))).toContain(inv.invoiceId);
      await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(ConflictException);
      expect(await actions(scope, inv.invoiceId)).toEqual([]);
    }

    // Given up: never picked again, the download says it failed, and one admin entry says so.
    const given = await failureRow(inv.invoiceId);
    expect(given?.exhausted_at).not.toBeNull();
    expect(given?.next_attempt_at).toBeNull();
    const farFuture = new Date(clock.getTime() + 365 * 24 * 60 * 60_000);
    expect(ids(await store.candidates(farFuture, 1_000))).not.toContain(inv.invoiceId);
    const refused = await service.link(inv.invoiceId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(424);
    expect(await actions(scope, inv.invoiceId)).toEqual(['invoice.pdf_render_failed']);
    // Another failure after giving up changes nothing and writes no second entry.
    expect(await worker.renderOne(inv)).toBe('failed');
    expect(await failureRow(inv.invoiceId)).toMatchObject({ attempts: MAX_RENDER_ATTEMPTS });
    expect(await actions(scope, inv.invoiceId)).toEqual(['invoice.pdf_render_failed']);

    // Retry needs invoice.issue on the invoice: a reader who may not issue sees the same 404 as a stranger.
    await expect(service.retry(inv.invoiceId)).rejects.toBeInstanceOf(NotFoundException);
    asStaff(scope, 'finance');
    retryNudge.nudge.mockClear();
    await expect(service.retry(inv.invoiceId)).resolves.toEqual({ state: 'queued' });
    // The Retry enqueues the render at once (after its commit), not on the next sweep; a refused Retry does not.
    expect(retryNudge.nudge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tenantId: scope.tenantId, organizationId: scope.organizationId }),
      inv.invoiceId,
    );
    expect(await failureRow(inv.invoiceId)).toBeUndefined();
    await expect(service.retry(inv.invoiceId)).rejects.toBeInstanceOf(ConflictException);
    expect(retryNudge.nudge).toHaveBeenCalledTimes(1);
    expect(await actions(scope, inv.invoiceId)).toEqual([
      'invoice.pdf_render_failed',
      'invoice.pdf_retry_requested',
    ]);
    // Back to "being prepared", due at once, and a healthy render now serves the PDF.
    await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(ConflictException);
    expect(ids(await store.candidates(clock, 1_000))).toContain(inv.invoiceId);
    await renderClean(inv);
    await expect(service.link(inv.invoiceId)).resolves.toBeDefined();
  });

  it('forgets earlier failures once a render succeeds', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    expect(await failingWorker(() => new Date()).renderOne(inv)).toBe('failed');
    expect(await failureRow(inv.invoiceId)).toMatchObject({ attempts: 1 });
    await renderClean(inv);
    expect(await failureRow(inv.invoiceId)).toBeUndefined();
  });

  it('removes the document of a try whose bytes were never stored, so the next try is not blocked', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const brokenDisk = {
      createGenerated: documents.createGenerated.bind(documents),
      receiveGenerated: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    let clock = new Date();
    const worker = new InvoiceRenderSweeper(
      store,
      runTx,
      brokenDisk,
      settings,
      { htmlToPdf: vi.fn().mockResolvedValue(PDF) },
      () => clock,
      NO_LOGOS,
      renderAudit,
    );
    expect(await worker.renderOne(inv)).toBe('failed');
    const [doc] = await documentRows(inv.invoiceId);
    expect(doc?.status).toBe('awaiting_content');
    expect(doc?.removed_at).not.toBeNull();
    const row = await failureRow(inv.invoiceId);
    clock = new Date((row?.next_attempt_at ?? new Date()).getTime() + 1);
    expect(ids(await store.candidates(clock, 1_000))).toContain(inv.invoiceId);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    expect((await documentRows(inv.invoiceId)).map((d) => d.status)).toEqual([
      'awaiting_content',
      'clean',
    ]);
  });

  it('removes the document whose bytes failed the PDF type check, so the render is tried again', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    let clock = new Date();
    // The renderer answered, but not with a PDF: the real receive rejects the bytes with a 415.
    const notAPdf = new InvoiceRenderSweeper(
      store,
      runTx,
      documents,
      settings,
      { htmlToPdf: vi.fn().mockResolvedValue(Buffer.from('<html>gateway error</html>')) },
      () => clock,
      NO_LOGOS,
      renderAudit,
    );
    expect(await notAPdf.renderOne(inv)).toBe('failed');
    const [doc] = await documentRows(inv.invoiceId);
    expect(doc?.status).toBe('rejected');
    expect(doc?.removed_at).not.toBeNull();
    const row = await failureRow(inv.invoiceId);
    expect(row).toMatchObject({ attempts: 1, last_failure_kind: 'http_415' });
    clock = new Date((row?.next_attempt_at ?? new Date()).getTime() + 1);
    expect(ids(await store.candidates(clock, 1_000))).toContain(inv.invoiceId);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    expect((await documentRows(inv.invoiceId)).map((d) => d.status)).toEqual(['rejected', 'clean']);
  });

  it('does not let a live document whose only upload was rejected block the next try or a Retry', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    asStaff(scope, 'finance');
    // The type check refused the bytes and the failure path could not remove the document (or the worker died
    // between the two), on the last try: the render is given up and the rejected document is still live.
    const orphan = await createOrphan(scope, inv.invoiceId, 0);
    // The way the receive moves it: claimed (quarantined), then refused by the type check.
    for (const status of ['quarantined', 'rejected']) {
      await withTx(db, scope, seedActor(), (tx) =>
        tx.execute(
          sql`UPDATE app.document_versions SET status = ${status} WHERE document_id = ${orphan}::uuid`,
        ),
      );
    }
    let clock = new Date();
    const worker = failingWorker(() => clock);
    for (let n = 1; n <= MAX_RENDER_ATTEMPTS; n += 1) {
      expect(await worker.renderOne(inv)).toBe('failed');
      clock = new Date((await failureRow(inv.invoiceId))?.next_attempt_at ?? clock);
    }
    expect((await failureRow(inv.invoiceId))?.exhausted_at).not.toBeNull();

    await expect(service.retry(inv.invoiceId)).resolves.toEqual({ state: 'queued' });
    // Retried, well inside the orphan cutoff: due at once, and the healthy render stores the PDF.
    expect(ids(await store.candidates(new Date(), 1_000))).toContain(inv.invoiceId);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    await expect(service.link(inv.invoiceId)).resolves.toBeDefined();
  });

  it('does not leave the owner on "Preparing PDF" when the stored PDF cannot be marked clean', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    asStaff(scope);
    // The bytes passed the type check, then moving them to clean storage failed (a disk or database blip).
    const failingDisk = Object.create(storage) as DiskStorageAdapter;
    failingDisk.promote = () => Promise.reject(new Error('disk is away'));
    const flakyDocuments = new DocumentsService(
      db,
      failingDisk,
      new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
      queue as unknown as Queue,
      authz,
      audit,
    );
    flakyDocuments.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(db)));
    let clock = new Date();
    const worker = new InvoiceRenderSweeper(
      store,
      runTx,
      flakyDocuments,
      settings,
      { htmlToPdf: vi.fn().mockResolvedValue(PDF) },
      () => clock,
      NO_LOGOS,
      renderAudit,
    );
    expect(await worker.renderOne(inv)).toBe('failed');

    // The try is counted and its document is out of the way: the next try comes after the pause, not after a scan
    // or the orphan cleanup, and the screen keeps saying "being prepared" until then.
    const row = await failureRow(inv.invoiceId);
    expect(row).toMatchObject({ attempts: 1 });
    const [doc] = await documentRows(inv.invoiceId);
    expect(doc?.status).toBe('rejected');
    expect(doc?.removed_at).not.toBeNull();
    await expect(service.link(inv.invoiceId)).rejects.toBeInstanceOf(ConflictException);
    clock = new Date((row?.next_attempt_at ?? new Date()).getTime() + 1);
    expect(ids(await store.candidates(clock, 1_000))).toContain(inv.invoiceId);
    expect(await sweeper.renderOne(inv)).toBe('rendered');
    await expect(service.link(inv.invoiceId)).resolves.toBeDefined();
  });

  it('counts a document left by a worker that crashed as a failed try, and gives up at the limit', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    let clock = new Date();
    const worker = failingWorker(() => clock);
    for (let n = 1; n < MAX_RENDER_ATTEMPTS; n += 1) {
      expect(await worker.renderOne(inv)).toBe('failed');
      clock = new Date((await failureRow(inv.invoiceId))?.next_attempt_at ?? clock);
    }
    expect(await failureRow(inv.invoiceId)).toMatchObject({ attempts: MAX_RENDER_ATTEMPTS - 1 });
    // The last try's worker died after createGenerated: no failure was recorded, only the unfilled document.
    const orphan = await createOrphan(scope, inv.invoiceId, ORPHAN_AFTER_MS + 60_000);

    await sweeper.sweep();

    const [doc] = (await documentRows(inv.invoiceId)).filter((d) => d.document_id === orphan);
    expect(doc?.removed_at).not.toBeNull();
    const given = await failureRow(inv.invoiceId);
    expect(given).toMatchObject({ attempts: MAX_RENDER_ATTEMPTS, last_failure_kind: 'abandoned' });
    expect(given?.exhausted_at).not.toBeNull();
    expect(await actions(scope, inv.invoiceId)).toEqual(['invoice.pdf_render_failed']);
    // Given up, so the crash loop ends: no later sweep takes it again.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    expect(ids(await store.candidates(farFuture, 1_000))).not.toContain(inv.invoiceId);
  });

  /** A worker over the real store whose print log write fails `failures` times, then goes to the real table. */
  const flakyPrintLog = (failures: number) => {
    let left = failures;
    const recordPrint = vi.fn<RenderStore['recordPrint']>((...args) => {
      if (left > 0) {
        left -= 1;
        return Promise.reject(new Error('print log down'));
      }
      return store.recordPrint(...args);
    });
    const worker = new InvoiceRenderSweeper(
      { ...store, recordPrint },
      runTx,
      documents,
      settings,
      { htmlToPdf: vi.fn().mockResolvedValue(PDF) },
      () => new Date(),
      NO_LOGOS,
      renderAudit,
    );
    return { worker, recordPrint };
  };

  it('keeps a stored PDF whose first print 1 write failed and records print 1 with its format on the retry', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const { worker, recordPrint } = flakyPrintLog(1);
    expect(await worker.renderOne(inv)).toBe('rendered');
    expect(recordPrint).toHaveBeenCalledTimes(2);
    const docs = await documentRows(inv.invoiceId);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe('clean');
    expect(docs[0]?.removed_at).toBeNull();
    const prints = await printFormats(inv.invoiceId);
    expect(prints.map((p) => p.print_no)).toEqual([1]);
    expect(prints[0]?.render_format).not.toBeNull();
    expect(await failureRow(inv.invoiceId)).toBeUndefined();
  });

  it('keeps a stored PDF live when print 1 cannot be recorded twice, and never renders a second original', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const { worker, recordPrint } = flakyPrintLog(2);
    expect(await worker.renderOne(inv)).toBe('rendered');
    expect(recordPrint).toHaveBeenCalledTimes(2);
    const [doc] = await documentRows(inv.invoiceId);
    expect(doc?.status).toBe('clean');
    expect(doc?.removed_at).toBeNull();
    // No print row yet (the next sweep writes it from the print stored with the PDF), and no failure counted.
    expect(await printFormats(inv.invoiceId)).toEqual([]);
    expect(await failureRow(inv.invoiceId)).toBeUndefined();
    // The live PDF keeps the invoice out of the candidates, so no later sweep prints another original.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    expect(ids(await store.candidates(farFuture, 1_000))).not.toContain(inv.invoiceId);
    expect(await sweeper.renderOne(inv)).toBe('skipped');
    expect(await documentRows(inv.invoiceId)).toHaveLength(1);
    expect(await printFormats(inv.invoiceId)).toEqual([]);
  });

  it('restores print 1 with its frozen format on the next sweep when both print writes failed', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const { worker } = flakyPrintLog(2);
    expect(await worker.renderOne(inv)).toBe('rendered');
    expect(await printFormats(inv.invoiceId)).toEqual([]);
    // The settings change before the next sweep: print 1 must keep what the stored PDF printed with.
    liveSettings['format.date'] = 'yyyy-MM-dd';

    await sweeper.sweep();

    const prints = await printFormats(inv.invoiceId);
    expect(prints.map((p) => p.print_no)).toEqual([1]);
    const format = DocumentFormatSnapshotSchema.parse(prints[0]?.render_format);
    expect(format.dateFormat).toBe('dd MMM yyyy');
    // Restored once: a second sweep writes nothing more.
    await sweeper.sweep();
    expect((await printFormats(inv.invoiceId)).map((p) => p.print_no)).toEqual([1]);
  });
});

describe('render on commit (S3): the issue enqueues the render, the worker renders it at once', () => {
  /** NPR at 1, as the issue tests price it. */
  const money = {
    toNprSnapshot: (_tx: unknown, _scope: unknown, m: { amount: string }) =>
      Promise.resolve({
        amountNpr: m.amount,
        rate: '1',
        rateSource: 'NPR',
        rateDate: '2026-11-09',
      }),
  } as unknown as MoneyService;
  /** The seller the issue snapshots: an address and a PAN, nothing else. */
  const issueSettings = {
    get: (_scope: unknown, key: string) =>
      Promise.resolve(
        key === 'entity.address'
          ? { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }
          : key === 'entity.pan_vat_no'
            ? PAN
            : null,
      ),
  } as unknown as SettingsService;

  it('has the PDF of an issued proforma ready within 10 s of the issue, with the sweep never run', async () => {
    const scope = await newScope();
    current.scope = scope;
    current.orgKind = 'staff';
    const draft = await seedInvoice(scope, { kind: 'proforma', status: 'draft' });
    // The issue snapshots the buyer's address: newScope's customer has its line, city and country (FX9).
    // The API side: the real nudge on a queue that hands over what was enqueued.
    const renderQueue = { add: vi.fn().mockResolvedValue({}) };
    const issuing = new InvoiceIssueService(
      db,
      authz as unknown as AuthzService,
      renderAudit,
      caller,
      new LedgerService(),
      new NumberingService(),
      money,
      issueSettings,
      () => new Date(),
      undefined,
      new InvoiceRenderNudge(renderQueue as unknown as Queue),
    );
    const sweep = vi.spyOn(sweeper, 'sweep');
    const started = Date.now();

    const result = await issuing.issue(draft.invoiceId, { expectedVersion: 1 }, randomUUID());
    expect(result).toMatchObject({ kind: 'issued', invoiceId: draft.invoiceId });

    // One job, enqueued after the commit, named and keyed by the invoice.
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = renderQueue.add.mock.calls[0] as [string, unknown, object];
    expect(name).toBe(INVOICE_RENDER_ONE_JOB);
    expect(data).toEqual({ ...scope_(scope), id: draft.invoiceId });
    expect(opts).toMatchObject({
      jobId: `invoice.render.one-${draft.invoiceId}`,
      removeOnComplete: true,
    });

    // The worker side: the real processor runs the job it was handed.
    await new InvoiceRenderProcessor(sweeper).process({ name, data } as unknown as Job);

    const link = await service.link(draft.invoiceId);
    expect(link.url.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sweep).not.toHaveBeenCalled();
    expect(gotenberg.requests).toHaveLength(1);
    sweep.mockRestore();
  });

  it('does not render twice when the job runs again after the PDF is live', async () => {
    const scope = await newScope();
    const inv = await seedInvoice(scope);
    const job = {
      name: INVOICE_RENDER_ONE_JOB,
      data: { ...scope_(scope), id: inv.invoiceId },
    } as unknown as Job;
    const processor = new InvoiceRenderProcessor(sweeper);
    await processor.process(job);
    await processor.process(job);
    expect(gotenberg.requests).toHaveLength(1);
    expect(await documentRows(inv.invoiceId)).toHaveLength(1);
  });
});

const scope_ = (s: TxScope): TxScope => ({
  tenantId: s.tenantId,
  organizationId: s.organizationId,
});
