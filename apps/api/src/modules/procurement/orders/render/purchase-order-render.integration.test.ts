// The purchase order render sweeper and the document route against real Postgres (P4 unit P3b). The real store, the real
// GotenbergClient talking over HTTP to a fake Gotenberg (a node:http server that answers one fixed PDF), the real
// DocumentsService on a temp dir with the real PurchaseOrderVersionOwnerPolicy registered as `purchase_order_version`,
// and the real ScanProcessor against the fake clamd. The POs are made by the real PurchaseOrdersService (issue and amend),
// so the versions are what the producer writes. Fakes: authz (it must never be called on the system path), audit of the
// documents module, the scan queue, the settings port (the entity's PAN) and the request context of the routes.
//
// Versions are immutable (bos_app has no UPDATE on them), so a test cannot retire one. Every test drives `renderOne`
// and asserts on its own version ids; the one test that calls `sweep()` asserts only on its own rows.
//
// What it holds:
//   * a PO of NPR 21,24,400.00 reaches Gotenberg with lakh grouping, titled "Purchase Order" with the buyer's PAN, the
//     vendor's name and PAN and both dates; the PDF is stored as a generated document owned by the version and is
//     `clean` at once (it skips the virus scan, D28; no scan job is queued), and the version row is untouched;
//   * after an amendment, version 1 still prints version 1's price (it is drawn from the snapshot, not the live lines)
//     and version 2 prints its own, in its own file;
//   * a USD PO prints neither the FX rate nor an NPR value;
//   * candidates: versions without a live document, never a rendered one;
//   * two renders at once give one document; Gotenberg 500 leaves no document and renders on the next try;
//   * an orphan generated document older than 1 h is soft-removed by a sweep, a younger one is kept;
//   * the owner policy refuses every actor but the render job;
//   * GET .../versions/:version/document: a link for the clean PDF right after the render; 404 for an unknown version, for
//     another entity of the same tenant and for a random id; 403 for a portal caller.
//
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/render/purchase-order-render.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { formatBs } from '@bos/locale';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../../platform/audit/audit.service';
import type { Principal } from '../../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../../platform/db/tx';
import { ClamdClient } from '../../../../platform/documents/clamd.client';
import {
  DocumentsService,
  type GeneratedFile,
} from '../../../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../../platform/documents/storage.adapter';
import type { ApprovalsService } from '../../../approvals/requests.service';
import { GotenbergClient } from '../../../quotations/render/gotenberg.client';
import { NO_DOCUMENT_LOGO_RESOLVER } from '../../../quotations/render/issuer';
import type {
  RenderLogos,
  RenderSettings,
  RunInTx,
} from '../../../quotations/render/quotation-render.sweeper';
import { quotationLineAmounts } from '../../sourcing/sourcing.rules';
import { PurchaseOrdersService } from '../purchase-orders.service';
import { PurchaseOrderDocumentService } from './purchase-order-document.service';
import {
  drizzlePurchaseOrderRenderStore,
  FAILED_RETRY_MS,
  ORPHAN_AFTER_MS,
  PurchaseOrderRenderSweeper,
  type RenderCandidate,
} from './purchase-order-render.sweeper';
import {
  drizzlePoVersionHeadLoader,
  PO_RENDER_JOB_PREFIX,
  PO_VERSION_OWNER_TYPE,
  PurchaseOrderVersionOwnerPolicy,
} from './purchase-order-version-owner.policy';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const ENTITY_PAN = '301234567';
const now = new Date('2026-11-09T04:00:00Z');

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

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let pool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let deptA = '';
let deptB = '';
let vatCode = '';
let entityLegalName = '';
let storageRoot: string;
let storage: DiskStorageAdapter;
let documents: DocumentsService;
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let gotenbergServer: Server;
let sweeper: PurchaseOrderRenderSweeper;
let store: ReturnType<typeof drizzlePurchaseOrderRenderStore>;
let service: PurchaseOrderDocumentService;
let orders: PurchaseOrdersService;
const U = { req: '', proc: '', mgmt: '' };

const gotenberg = { mode: 'ok' as 'ok' | 'error', requests: [] as string[] };
const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };
/** No logo document resolves here: the logo freeze is covered by the sweeper's unit tests. */
const NO_LOGOS: RenderLogos = { forScope: () => NO_DOCUMENT_LOGO_RESOLVER };
const settings = {
  get: vi.fn((_scope: TxScope, key: string) =>
    Promise.resolve(key === 'entity.pan_vat_no' ? ENTITY_PAN : null),
  ),
} as unknown as RenderSettings;

const runTx: RunInTx = (scope, actor, fn) => withTx(db, scope, actor, fn);
// Not the render job: its id must not satisfy the policy.
const seedActor = () => systemActor('po-render-test-seed');
const renderActor = () => systemActor(PO_RENDER_JOB_PREFIX);

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The caller of the routes and of the PO service; each test sets it. */
const current: { scope: TxScope | null; orgKind: Principal['orgKind'] } = {
  scope: null,
  orgKind: 'staff',
};
const caller = {
  current: () => {
    const scope = current.scope ?? scopeA;
    return {
      scope,
      actor: { kind: 'user' as const, id: U.proc, correlationId: 'test-corr' },
      principal: {
        userId: U.proc,
        zitadelUserId: 'z-test',
        ...scope,
        orgKind: current.orgKind,
        partyId: null,
        idpOrgId: 'unused',
        roles: ['procurement'],
        departmentId: null,
        status: 'active',
        grants: grantsOf('procurement'),
      } satisfies Principal,
    };
  },
};

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, seedActor(), (tx) => tx.execute(q));

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

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  pool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: pool });

  const tenant = await createTenantWithEntity(pool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
        VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  const { rows: orgRows } = await pool.query<{ legal_name: string }>(
    'SELECT legal_name FROM app.organizations WHERE id = $1',
    [scopeA.organizationId],
  );
  entityLegalName = first(orgRows).legal_name;

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(pool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.req = await staff('operations_officer');
  U.proc = await staff('procurement');
  U.mgmt = await staff('management');
  deptA = (await createDepartment(pool, scopeA)).departmentId;
  deptB = (await createDepartment(pool, scopeB)).departmentId;
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;

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

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-po-render-'));
  storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  // The real policy of a version, as the worker and API modules register it.
  documents.registerOwner(new PurchaseOrderVersionOwnerPolicy(drizzlePoVersionHeadLoader(db)));
  store = drizzlePurchaseOrderRenderStore(db);

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
  service = new PurchaseOrderDocumentService(db, documents, caller);
  // Issue and amend do not touch the approvals service while the band does not rise.
  orders = new PurchaseOrdersService(
    db,
    {} as ApprovalsService,
    new AuditService(db),
    caller,
    () => now,
  );
});

afterAll(async () => {
  await fakeClamd?.close();
  gotenbergServer?.closeAllConnections();
  await new Promise<void>((resolve) =>
    gotenbergServer ? gotenbergServer.close(() => resolve()) : resolve(),
  );
  await pool?.end();
  await ownerPool?.end();
  await container?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  gotenberg.mode = 'ok';
  gotenberg.requests.length = 0;
  authz.assert.mockReset();
  audit.record.mockClear();
  queue.add.mockReset().mockResolvedValue({});
  current.scope = null;
  current.orgKind = 'staff';
});

// ---------------------------------------------------------------------------------------- helpers

function makeSweeper(pdf: GotenbergClient): PurchaseOrderRenderSweeper {
  return new PurchaseOrderRenderSweeper(
    store,
    runTx,
    documents,
    settings,
    pdf,
    () => new Date(),
    NO_LOGOS,
  );
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

let panSeq = 0;
/** An approved vendor with an active account in each of `accountIn`. */
async function vendor(accountIn: TxScope[]): Promise<{ id: string; name: string; pan: string }> {
  const { partyId } = await createParty(pool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  const name = `Himal Solar ${partyId.slice(0, 6)}`;
  const pan = String(200_000_000 + (panSeq += 1));
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${name}, ${pan}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  for (const s of accountIn) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
    );
  }
  return { id: partyId, name, pan };
}

let poSeq = 0;

interface PoOptions {
  scope?: TxScope;
  currency?: 'NPR' | 'USD';
  quantity?: string;
  unitPrice?: string;
  deliveryLocation?: string;
  issuedAt?: Date;
}

interface IssuedPo {
  id: string;
  number: string;
  lineId: string;
  vendor: { id: string; name: string; pan: string };
  scope: TxScope;
}

/**
 * A draft PO in `scope` (P2's shape: number taken, version 0) issued through the real service: version 1 with
 * `quantity` x `unitPrice` plus 13% VAT. The default 1 x 18,80,000.00 is NPR 21,24,400.00 with VAT.
 */
async function issuedPo(opts: PoOptions = {}): Promise<IssuedPo> {
  const scope = opts.scope ?? scopeA;
  const currency = opts.currency ?? 'NPR';
  const fx = currency === 'NPR' ? '1' : '133.5';
  const quantity = opts.quantity ?? '1';
  const unitPrice = opts.unitPrice ?? '1880000.00';
  const v = await vendor([scopeA, scopeB]);
  const a = quotationLineAmounts(quantity, unitPrice, 1300);
  const totalNpr = (Number(a.lineTotal) * Number(fx)).toFixed(2);
  const prId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, delivery_location, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods',
                ${scope === scopeA ? deptA : deptB}, ${U.req}, ${(await createCostCenter(pool, scope)).costCenterId}, 'Solar array', '2026-12-01',
                ${opts.deliveryLocation ?? 'Teku warehouse'}, 'IT-2083', ${currency})`,
  );
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = ${fx}::numeric,
          fx_source = ${currency === 'NPR' ? null : 'NRB'}, fx_date = ${currency === 'NPR' ? null : '2026-11-08'}::date,
          estimated_total = ${a.lineTotal}, estimated_total_npr = ${totalNpr},
          number = ${`PR-T-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  const number = `PO-2083/84-${String(poSeq).padStart(5, '0')}`;
  await exec(
    scope,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, advance_percent, approved_total, fx_rate,
          fx_source, fx_date, approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${number}, ${poSeq}, '2083/84',
                ${prId}, ${v.id}, ${currency}, 45, 25, ${a.lineTotal}, ${fx}::numeric,
                ${currency === 'NPR' ? null : 'NRB'}, ${currency === 'NPR' ? null : '2026-11-08'}::date,
                ${totalNpr}, 'founder', ${U.proc})`,
  );
  const lineId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${lineId}, ${scope.tenantId}, ${scope.organizationId}, ${id}, ${prId}, 1, 'goods', 'Solar panel array',
                'set', ${quantity}, ${unitPrice}, ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  current.scope = scope;
  const issuer =
    opts.issuedAt === undefined
      ? orders
      : new PurchaseOrdersService(
          db,
          {} as ApprovalsService,
          new AuditService(db),
          caller,
          () => opts.issuedAt ?? now,
        );
  await issuer.issue(id, randomUUID());
  return { id, number, lineId, vendor: v, scope };
}

/** Amends line 1 to `unitPrice`: the band does not rise, so version 2 is written at once. */
async function amend(po: IssuedPo, unitPrice: string): Promise<void> {
  current.scope = po.scope;
  const r = await orders.amend(
    po.id,
    { reason: 'Vendor revised the price', lines: [{ poLineId: po.lineId, unitPrice }] },
    randomUUID(),
  );
  expect(r.outcome).toBe('applied');
}

async function candidateOf(po: IssuedPo, version: number): Promise<RenderCandidate> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM app.purchase_order_versions WHERE purchase_order_id = $1 AND version = $2',
    [po.id, version],
  );
  return { ...po.scope, versionId: first(rows).id };
}

async function documentRows(versionId: string) {
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
    [PO_VERSION_OWNER_TYPE, versionId],
  );
  return rows;
}

async function versionRow(versionId: string) {
  const { rows } = await pool.query<{ total: string; snapshot: unknown; created_at: Date }>(
    'SELECT total, snapshot, created_at FROM app.purchase_order_versions WHERE id = $1',
    [versionId],
  );
  return first(rows);
}

const scanJob = (scope: TxScope, versionId: string) => ({
  versionId,
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
});

/** An orphan: a generated document created for the version and never given its bytes. */
async function createOrphan(c: RenderCandidate, ageMs: number): Promise<string> {
  const file: GeneratedFile = {
    filename: 'orphan.pdf',
    declaredMime: 'application/pdf',
    bytes: PDF,
  };
  const created = await withTx(db, c, renderActor(), (tx: DbTransaction) =>
    documents.createGenerated(tx, { ownerType: PO_VERSION_OWNER_TYPE, ownerId: c.versionId }, file),
  );
  await exec(
    c,
    sql`UPDATE app.documents SET created_at = ${new Date(Date.now() - ageMs).toISOString()}::timestamptz
         WHERE id = ${created.documentId}::uuid`,
  );
  return created.documentId;
}

/** Renders the version; the generated PDF is clean at once (D28), with no scan to wait for. */
async function renderClean(c: RenderCandidate): Promise<void> {
  expect(await sweeper.renderOne(c)).toBe('rendered');
  expect(first(await documentRows(c.versionId)).status).toBe('clean');
}

// ------------------------------------------------------------------------------------------- tests

describe('purchase order render', () => {
  it('reaches newer pending versions past multiple failing batches and wraps after a rendered cursor', async () => {
    const failed: RenderCandidate[] = [];
    for (let i = 0; i < 25; i += 1) {
      failed.push(await candidateOf(await issuedPo(), 1));
    }
    const healthyPo = await issuedPo({ issuedAt: new Date(now.getTime() + 1_000) });
    const healthy = await candidateOf(healthyPo, 1);
    const fairStore = drizzlePurchaseOrderRenderStore(db);
    const load = vi.spyOn(fairStore, 'load');
    let clock = now;
    const pdf = {
      htmlToPdf: vi.fn((html: string) => {
        if (html.includes(healthyPo.number)) return Promise.resolve(PDF);
        return Promise.reject(new Error('permanent render failure'));
      }),
    };
    const worker = new PurchaseOrderRenderSweeper(
      fairStore,
      runTx,
      documents,
      settings,
      pdf,
      () => clock,
      NO_LOGOS,
    );

    // Every retry has expired before the next tick. The oldest-first query used to pick the same ten forever.
    for (let tick = 0; tick < 3; tick += 1) {
      await worker.sweep();
      clock = new Date(clock.getTime() + FAILED_RETRY_MS + 1);
    }
    expect(await documentRows(healthy.versionId)).toHaveLength(1);
    expect(new Set(load.mock.calls.map(([, c]) => c.versionId))).toEqual(
      new Set([...failed, healthy].map((c) => c.versionId)),
    );

    // The cursor's row still defines its position after its PDF makes it ineligible. Equal timestamps use id order.
    load.mockClear();
    await worker.sweep();
    const { rows: oldest } = await pool.query<{ id: string }>(
      'SELECT id FROM app.purchase_order_versions WHERE id = ANY($1::uuid[]) ORDER BY created_at, id LIMIT 10',
      [failed.map((c) => c.versionId)],
    );
    expect(load.mock.calls.map(([, c]) => c.versionId)).toEqual(oldest.map((r) => r.id));
    // A removed cursor cannot poison future candidate queries: restart at the oldest available position.
    expect((await fairStore.candidates(10, [], randomUUID())).map((c) => c.versionId)).toEqual(
      oldest.map((r) => r.id),
    );
  });

  it('prints NPR 21,24,400.00 and stores a clean PDF owned by the version', async () => {
    const po = await issuedPo();
    const c = await candidateOf(po, 1);
    const before = await versionRow(c.versionId);

    expect(await sweeper.renderOne(c)).toBe('rendered');

    // What Chromium was asked to print.
    expect(gotenberg.requests).toHaveLength(1);
    const html = first(gotenberg.requests);
    expect(html).toContain('NPR 21,24,400.00');
    expect(html).toContain('NPR 18,80,000.00');
    expect(html).not.toContain('2,124,400');
    expect(html).toContain('Purchase Order');
    expect(html).toContain(po.number);
    expect(html).toContain(entityLegalName);
    expect(html).toContain(`PAN/VAT ${ENTITY_PAN}`);
    expect(html).toContain(po.vendor.name);
    expect(html).toContain(`PAN ${po.vendor.pan}`);
    expect(html).toContain('Solar panel array');
    expect(html).toContain('VAT13');
    expect(html).toContain('45 days');
    expect(html).toContain('25%');
    expect(html).toContain('Teku warehouse');
    expect(html).toContain(`${formatBs(before.created_at, 'YYYY-MM-DD')} BS`);
    expect(authz.assert).not.toHaveBeenCalled();

    // One generated document, owned by the version, with no user behind it, named for the number and version.
    const docs = await documentRows(c.versionId);
    expect(docs).toHaveLength(1);
    const doc = first(docs);
    expect(doc.uploaded_by).toBeNull();
    expect(doc.removed_at).toBeNull();
    expect(doc.filename).toBe(`${po.number.replaceAll('/', '-')}-v1.pdf`);
    // Generated bytes skip the virus scan (D28): clean at once, no scan job, and a stray scan job is a no-op.
    expect(doc.status).toBe('clean');
    expect(queue.add).not.toHaveBeenCalled();
    expect(await processor.scanVersion(scanJob(c, doc.version_id), true)).toBe('skipped');

    // The immutable version did not move.
    const after = await versionRow(c.versionId);
    expect(after).toEqual(before);
  });

  it('keeps version 1 at version 1 after an amendment, and prints version 2 on its own', async () => {
    const po = await issuedPo();
    await amend(po, '1500000.00');
    const v1 = await candidateOf(po, 1);
    const v2 = await candidateOf(po, 2);

    expect(await sweeper.renderOne(v1)).toBe('rendered');
    const html1 = first(gotenberg.requests);
    expect(html1).toContain('NPR 18,80,000.00');
    expect(html1).toContain('NPR 21,24,400.00');
    expect(html1).not.toContain('NPR 15,00,000.00');
    expect(html1).toContain('Version 1');

    gotenberg.requests.length = 0;
    expect(await sweeper.renderOne(v2)).toBe('rendered');
    const html2 = first(gotenberg.requests);
    expect(html2).toContain('NPR 15,00,000.00');
    expect(html2).toContain('NPR 16,95,000.00');
    expect(html2).not.toContain('NPR 21,24,400.00');
    expect(html2).toContain('Version 2');

    expect(first(await documentRows(v1.versionId)).filename).toBe(
      `${po.number.replaceAll('/', '-')}-v1.pdf`,
    );
    expect(first(await documentRows(v2.versionId)).filename).toBe(
      `${po.number.replaceAll('/', '-')}-v2.pdf`,
    );
  });

  it('prints a USD PO in USD, with neither the FX rate nor an NPR value', async () => {
    const po = await issuedPo({ currency: 'USD', quantity: '10', unitPrice: '1500.00' });
    const c = await candidateOf(po, 1);
    expect(await sweeper.renderOne(c)).toBe('rendered');
    const html = first(gotenberg.requests);
    expect(html).toContain('USD 16,950.00');
    expect(html).not.toContain('NPR');
    expect(html).not.toContain('133.5');
    expect(html).not.toContain('2,262,825');
    expect(html).not.toContain('22,62,825');
    expect(html).not.toContain('NRB');
  });

  it('picks versions without a live document, nothing else', async () => {
    const fresh = await candidateOf(await issuedPo(), 1);
    const rendered = await candidateOf(await issuedPo(), 1);
    expect(await sweeper.renderOne(rendered)).toBe('rendered');

    const picked = (await store.candidates(1_000, [])).map((c) => c.versionId);

    expect(picked).toContain(fresh.versionId);
    expect(picked).not.toContain(rendered.versionId);
    expect(
      (await store.candidates(1_000, [fresh.versionId])).map((c) => c.versionId),
    ).not.toContain(fresh.versionId);
  });

  it('two renders at once give one document', async () => {
    const c = await candidateOf(await issuedPo(), 1);

    const outcomes = await Promise.all([sweeper.renderOne(c), sweeper.renderOne(c)]);

    expect([...outcomes].sort()).toEqual(['rendered', 'skipped']);
    expect(await documentRows(c.versionId)).toHaveLength(1);
  });

  it('leaves no document when Gotenberg fails, and renders on the next try', async () => {
    const c = await candidateOf(await issuedPo(), 1);
    gotenberg.mode = 'error';

    expect(await sweeper.renderOne(c)).toBe('failed');
    expect(await documentRows(c.versionId)).toHaveLength(0);

    gotenberg.mode = 'ok';
    expect(await sweeper.renderOne(c)).toBe('rendered');
    expect(await documentRows(c.versionId)).toHaveLength(1);
  });

  it('fails a version that is not there, without a document or a render', async () => {
    const ghost: RenderCandidate = { ...scopeA, versionId: randomUUID() };
    expect(await sweeper.renderOne(ghost)).toBe('failed');
    expect(gotenberg.requests).toHaveLength(0);
  });

  it('removes an orphan older than an hour and keeps a younger one', async () => {
    const old = await candidateOf(await issuedPo(), 1);
    const young = await candidateOf(await issuedPo(), 1);
    const oldDoc = await createOrphan(old, ORPHAN_AFTER_MS + 60_000);
    const youngDoc = await createOrphan(young, ORPHAN_AFTER_MS - 60_000);

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

describe('owner policy of purchase_order_version', () => {
  const file: GeneratedFile = { filename: 'x.pdf', declaredMime: 'application/pdf', bytes: PDF };

  it('refuses every actor but the render job, and a version of another entity', async () => {
    const c = await candidateOf(await issuedPo(), 1);
    const owner = { ownerType: PO_VERSION_OWNER_TYPE, ownerId: c.versionId };
    for (const actor of [
      seedActor(),
      systemActor('quotation-render'),
      { kind: 'user' as const, id: U.proc, correlationId: 'c' },
    ]) {
      await expect(
        withTx(db, c, actor, (tx) => documents.createGenerated(tx, owner, file)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    // Entity B cannot add to entity A's version either, even as the render job: the owner is not found there.
    await expect(
      withTx(db, scopeB, renderActor(), (tx) => documents.createGenerated(tx, owner, file)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await documentRows(c.versionId)).toHaveLength(0);
  });
});

describe('GET /v1/procurement/purchase-orders/:id/versions/:version/document', () => {
  it('links the clean PDF right after the render, with no scan in between', async () => {
    const po = await issuedPo();
    const c = await candidateOf(po, 1);
    current.scope = scopeA;
    // Not rendered yet: nothing to serve.
    await expect(service.link(po.id, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(await sweeper.renderOne(c)).toBe('rendered');

    const link = await service.link(po.id, 1);
    expect(link.url.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(link.expiresAt))).toBe(false);
  });

  it('serves each version its own PDF', async () => {
    const po = await issuedPo();
    await amend(po, '1500000.00');
    const v1 = await candidateOf(po, 1);
    await renderClean(v1);
    current.scope = scopeA;
    await expect(service.link(po.id, 1)).resolves.toBeDefined();
    // Version 2 has no PDF yet.
    await expect(service.link(po.id, 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 404 for an unknown version, a random id, another entity and before any render', async () => {
    const po = await issuedPo();
    const unrendered = await issuedPo();
    await renderClean(await candidateOf(po, 1));

    current.scope = scopeA;
    await expect(service.link(unrendered.id, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(randomUUID(), 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(po.id, 2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(po.id, 0)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(po.id, 2_147_483_648)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.link(po.id, 1)).resolves.toBeDefined();

    // Another legal entity of the same tenant cannot see it, and the answer is the same 404.
    current.scope = scopeB;
    await expect(service.link(po.id, 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 403 for a portal caller', async () => {
    const po = await issuedPo();
    await renderClean(await candidateOf(po, 1));
    current.scope = scopeA;
    current.orgKind = 'vendor';
    await expect(service.link(po.id, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
