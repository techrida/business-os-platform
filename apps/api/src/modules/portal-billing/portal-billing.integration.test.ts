// Integration test of the portal invoice reads over HTTP on a real database (Testcontainers; P3 done check 2). Real:
// every migration as bos_owner, every query as bos_app, the controller behind configureApp and ErrorBodyFilter (the
// body a client sees), PortalBillingService, LedgerService for the debit open item, and DocumentsService with the real
// InvoiceOwnerPolicy, disk storage and SignedLinks. Faked: the request
// principal (PortalCaller); the route permission is the controller's @Can, checked by route-policy.check.test.ts.
// It pins: the customer's own draft, submitted, returned, approved and discarded invoices, an issued proforma, another
// party's issued invoice, the own party's issued invoice in a non-default entity and a random uuid all answer a
// byte-identical 404 on every `:id` route and never appear in the list; acting at the non-default entity shows
// nothing. The PDF state (round 5, P5): the view's `file` and `renderFailed` and the document route follow
// generatedPdfState, as the staff download does: no PDF yet or one awaiting its scan is pending (409), a given-up
// render or a scan-refused file is failed (424), and the clean original wins over a newer file that is not clean.
// Another customer's failed invoice still answers the one plain 404.
// Seeds copy receivables.integration.test.ts: a draft row (with its lines and tax row) moved to its status in one
// UPDATE, plus the debit open item through LedgerService, as U6's issue writes it.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  CustomerInvoiceViewSchema,
  ErrorBodySchema,
  PortalInvoiceListItemSchema,
  SignedLinkDtoSchema,
} from '@bos/contracts';
import { createParty, createPortalUser, createTenantWithEntity, invoicePrintLog } from '@bos/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { DocumentsService, type GeneratedFile } from '../../platform/documents/documents.service';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import {
  drizzleInvoiceHeadLoader,
  INVOICE_OWNER_TYPE,
  InvoiceOwnerPolicy,
} from '../invoices/invoice-owner.policy';
import { recordRenderFailure, type RenderFailureOwner } from '../invoices/render/render-failures';
import { LedgerService } from '../ledger/ledger.service';
import { PortalBillingController } from './portal-billing.controller';
import { PortalBillingService } from './portal-billing.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const SIGNING_SECRET = 'an-integration-test-secret-of-32-plus-chars';
/** 11:45 in Kathmandu on 2026-11-09; seeded invoices are issued 2026-11-01 and due 2026-11-05. */
const NOW = new Date('2026-11-09T06:00:00Z');
/** One request id on every probe, so the error bodies can be compared byte for byte. */
const REQUEST_ID = 'portal-billing-probe-0001';
const SIGNED_PATH = /^\/v1\/files\/[A-Za-z0-9._~-]+$/;
const ADDRESS = { line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' };

class MemoryLinkStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let storageRoot: string;
let documents: DocumentsService;
let settings: SettingsService;
let app: INestApplication;
let baseUrl: string;
const ledger = new LedgerService();
const seedActor = systemActor('portal-billing-test-seed');
let nextSeq = 1;

/** The principal of the current request; each test sets it. */
let current: Principal;
const caller = { current: () => current };

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: pool });

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-portal-billing-'));
  const storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SIGNING_SECRET, new MemoryLinkStore(), () => Date.now()),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    { assert: vi.fn() },
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  // The real policy: only the invoice render job adds a file, and only to an issued invoice.
  documents.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(db)));

  settings = new SettingsService(db);
  const service = new PortalBillingService(caller, db, documents, settings, () => NOW);
  const moduleRef = await Test.createTestingModule({
    controllers: [PortalBillingController],
    providers: [{ provide: PortalBillingService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------- seed

interface World {
  tenantId: string;
  /** The tenant's default entity. */
  entityA: string;
  /** A second, non-default legal entity of the same tenant. */
  entityB: string;
  /** The caller's party. */
  partyP: string;
  /** Another customer of the same tenant. */
  partyQ: string;
  taxCodeId: string;
}

async function seedWorld(): Promise<World> {
  const { tenantId, organizationId: entityA } = await createTenantWithEntity(pool);
  const scopeA: TxScope = { tenantId, organizationId: entityA };
  const entityB = randomUUID();
  await withTx(db, scopeA, seedActor, (tx) =>
    tx.execute(sql`
      INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
      VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB.slice(0, 8)}`},
              ${`E-${entityB}`}, false)`),
  );
  const parties: string[] = [];
  for (const name of ['Himal Traders', 'Other Buyer']) {
    const { partyId } = await createParty(pool, { tenantId, kind: 'customer' });
    await withTx(db, scopeA, seedActor, (tx) =>
      tx.execute(sql`
        INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
        VALUES (${partyId}::uuid, ${tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`}, ${name},
                ${`${name.toLowerCase()}-${partyId}`}, ${JSON.stringify(ADDRESS)}::jsonb)`),
    );
    parties.push(partyId);
  }
  const taxCodeId = await withTx(db, scopeA, seedActor, async (tx) => {
    const taxCode = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
      VALUES (${tenantId}::uuid, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`);
    return first(taxCode.rows).id;
  });
  return { tenantId, entityA, entityB, partyP: parties[0]!, partyQ: parties[1]!, taxCodeId };
}

type SeedStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'discarded' | 'issued';
type SeedKind = 'tax_invoice' | 'proforma' | 'credit_note' | 'debit_note';

/**
 * One invoice of `party` in `entity`: 2 x 500.00 + VAT 13% = 1,130.00 NPR, with its line and tax row, moved to `status`
 * in one UPDATE. An issued tax invoice or debit note also gets its debit open item.
 */
async function seedInvoice(
  w: World,
  entity: string,
  party: string,
  status: SeedStatus,
  kind: SeedKind = 'tax_invoice',
  original?: string,
): Promise<string> {
  const scope: TxScope = { tenantId: w.tenantId, organizationId: entity };
  return withTx(db, scope, seedActor, async (tx) => {
    const id = first(
      (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO app.invoices
            (tenant_id, organization_id, kind, customer_party_id, original_invoice_id, manual_reason, note_reason,
             currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total)
          VALUES (${w.tenantId}, ${entity}, ${kind}, ${party}, ${original ?? null},
                  ${kind === 'tax_invoice' ? 'One-off sale' : null},
                  ${kind === 'credit_note' || kind === 'debit_note' ? 'Price correction' : null},
                  'NPR', 1000, 0, 1000, 130, 1130)
          RETURNING id`)
      ).rows,
    ).id;
    await tx.execute(sql`
      INSERT INTO app.invoice_lines
        (tenant_id, organization_id, invoice_id, line_no, description, uom, quantity, unit_price, tax_code_id,
         gross, discount_alloc, taxable)
      VALUES (${w.tenantId}, ${entity}, ${id}, 1, 'Solar panel', 'pcs', 2, 500, ${w.taxCodeId}, 1000, 0, 1000)`);
    await tx.execute(sql`
      INSERT INTO app.invoice_tax_summary
        (tenant_id, organization_id, invoice_id, tax_code_id, label, rate, base, tax)
      VALUES (${w.tenantId}, ${entity}, ${id}, ${w.taxCodeId}, 'VAT', 13, 1000, 130)`);
    if (status === 'issued') {
      const seq = nextSeq++;
      const prefix = { tax_invoice: 'INV', proforma: 'PI', credit_note: 'CN', debit_note: 'DN' }[
        kind
      ];
      const seller = {
        legalName: 'Techrida Pvt. Ltd.',
        panVatNo: '301234567',
        address: 'Kathmandu',
      };
      const buyer = {
        legalName: 'Himal Traders',
        panVatNo: null,
        address: 'Durbar Marg 1, Kathmandu',
      };
      await tx.execute(sql`
        UPDATE app.invoices
           SET status = 'issued', number = ${`${prefix}-2083/84-${String(seq).padStart(5, '0')}`}, seq = ${seq},
               fiscal_year = '2083/84', issue_date = '2026-11-01', issue_date_bs = '2083-07-15',
               due_date = '2026-11-05', fx_rate = 1, amount_npr = total,
               seller_snapshot = ${JSON.stringify(seller)}::jsonb, buyer_snapshot = ${JSON.stringify(buyer)}::jsonb,
               content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now()
         WHERE id = ${id}`);
      if (kind === 'tax_invoice' || kind === 'debit_note') {
        await ledger.openItem(tx, scope, seedActor, {
          side: 'receivable',
          direction: 'debit',
          partyId: party,
          sourceType: kind,
          sourceId: id,
          currency: 'NPR',
          amount: '1130.00',
          amountNpr: '1130.00',
          fxRate: '1',
          documentDate: '2026-11-01',
          dueDate: '2026-11-05',
        });
      }
    } else if (status === 'discarded') {
      await tx.execute(
        sql`UPDATE app.invoices SET status = 'discarded', discarded_at = now() WHERE id = ${id}`,
      );
    } else if (status !== 'draft') {
      await tx.execute(sql`UPDATE app.invoices SET status = ${status} WHERE id = ${id}`);
    }
    return id;
  });
}

const pdf = (): GeneratedFile => ({
  filename: 'INV-2083-84-00001.pdf',
  declaredMime: 'application/pdf',
  bytes: Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    Buffer.alloc(200, 0x20),
  ]),
});

/**
 * The invoice PDF the way the render job (U11) leaves it: clean at once (D28, generated bytes skip the scan).
 * `scan: false` leaves it quarantined instead, awaiting a scan, as an upload would be.
 */
async function renderPdf(
  scope: TxScope,
  invoiceId: string,
  opts: { scan?: boolean } = {},
): Promise<{ documentId: string }> {
  const file = pdf();
  const who = { scope, actor: systemActor('invoice-render') };
  const created = await withTx(db, scope, who.actor, (tx) =>
    documents.createGenerated(tx, { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId }, file),
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
    await documents.receiveGenerated(created, file, who);
  }
  return { documentId: created.documentId };
}

/** Fails the invoice's render until it is given up, as the render sweeper does after its last try. */
async function giveUpRender(scope: TxScope, invoiceId: string): Promise<void> {
  const owner: RenderFailureOwner = { ...scope, ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId };
  for (let i = 0; i < 20; i++) {
    const { givenUp } = await withTx(db, scope, systemActor('invoice-render'), (tx) =>
      recordRenderFailure(tx, owner, 'render_error', NOW),
    );
    if (givenUp) return;
  }
  throw new Error('the render was never given up');
}

/** The virus scan's verdict on every upload of one document. */
async function setScanStatus(scope: TxScope, documentId: string, status: string): Promise<void> {
  await withTx(db, scope, seedActor, (tx) =>
    tx.execute(
      sql`UPDATE app.document_versions SET status = ${status} WHERE document_id = ${documentId}::uuid`,
    ),
  );
}

function customerOf(w: World, party: string, entity: string = w.entityA): Principal {
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
    grants: new Map([['portal.invoice.read', 'customer_org']]),
  };
}

const get = (path: string) => request(baseUrl).get(path).set('x-request-id', REQUEST_ID);

async function listIds(): Promise<string[]> {
  const res = await get('/v1/portal/invoices');
  expect(res.status, res.text).toBe(200);
  return z
    .array(PortalInvoiceListItemSchema)
    .parse(res.body)
    .map((i) => i.id);
}

// ---------------------------------------------------------------------------------------- tests

describe('portal invoice reads over HTTP on a real database', () => {
  it('refuses a real vendor portal principal on every customer invoice route', async () => {
    const w = await seedWorld();
    const invoiceId = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const vendor = await createParty(pool, { tenantId: w.tenantId, kind: 'vendor' });
    const user = await createPortalUser(pool, { tenantId: w.tenantId, idpOrgId: vendor.idpOrgId });
    current = {
      ...customerOf(w, vendor.partyId),
      userId: user.userId,
      idpOrgId: vendor.idpOrgId,
      orgKind: 'vendor',
      roles: ['vendor_user'],
    };
    // Even a principal carrying the customer grant must fail the counterparty-kind boundary.
    const bodies = new Set<string>();
    for (const suffix of [
      '',
      `/${invoiceId}`,
      `/${invoiceId}/settlement`,
      `/${invoiceId}/document`,
    ]) {
      const res = await get(`/v1/portal/invoices${suffix}`);
      expect(res.status, res.text).toBe(403);
      expect(ErrorBodySchema.parse(res.body).error.code).toBe('forbidden');
      bodies.add(res.text);
    }
    expect(bodies.size).toBe(1);
    current = customerOf(w, w.partyP);
    expect(await listIds()).toEqual([invoiceId]);
  });

  it('answers one byte-identical 404 for every hidden id on every route, and lists none of them', async () => {
    const w = await seedWorld();
    const ownIssued = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const hidden: Record<string, string> = {
      draft: await seedInvoice(w, w.entityA, w.partyP, 'draft'),
      submitted: await seedInvoice(w, w.entityA, w.partyP, 'submitted'),
      returned: await seedInvoice(w, w.entityA, w.partyP, 'returned'),
      approved: await seedInvoice(w, w.entityA, w.partyP, 'approved'),
      discarded: await seedInvoice(w, w.entityA, w.partyP, 'discarded'),
      issuedProforma: await seedInvoice(w, w.entityA, w.partyP, 'issued', 'proforma'),
      otherPartyIssued: await seedInvoice(w, w.entityA, w.partyQ, 'issued'),
      ownIssuedInEntityB: await seedInvoice(w, w.entityB, w.partyP, 'issued'),
      randomUuid: randomUUID(),
    };
    current = customerOf(w, w.partyP);

    // The list holds exactly the own issued invoice of the default entity.
    expect(await listIds()).toEqual([ownIssued]);

    const bodies = new Set<string>();
    for (const [name, id] of Object.entries(hidden)) {
      for (const suffix of ['', '/settlement', '/document']) {
        const res = await get(`/v1/portal/invoices/${id}${suffix}`);
        expect(res.status, `${name}${suffix}: ${res.text}`).toBe(404);
        bodies.add(res.text);
      }
    }
    expect(bodies.size, [...bodies].join('\n')).toBe(1);
    const [body] = [...bodies];
    expect(JSON.parse(body!)).toEqual({
      error: { code: 'not_found', message: 'Invoice not found', correlationId: REQUEST_ID },
    });

    // The own visible invoice is a 200 on the same routes; its PDF is not rendered yet, so the document is a 409.
    expect((await get(`/v1/portal/invoices/${ownIssued}`)).status).toBe(200);
    expect((await get(`/v1/portal/invoices/${ownIssued}/settlement`)).status).toBe(200);
    const noPdf = await get(`/v1/portal/invoices/${ownIssued}/document`);
    expect(noPdf.status, noPdf.text).toBe(409);
  });

  it('shows only the default entity: acting at another entity lists nothing and answers the same 404', async () => {
    const w = await seedWorld();
    await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const inB = await seedInvoice(w, w.entityB, w.partyP, 'issued');
    current = customerOf(w, w.partyP, w.entityB);
    expect(await listIds()).toEqual([]);
    const res = await get(`/v1/portal/invoices/${inB}`);
    expect(res.status).toBe(404);
    const unknown = await get(`/v1/portal/invoices/${randomUUID()}`);
    expect(res.text).toBe(unknown.text);
  });

  it('builds the strict customer view, the derived settlement and a clean-PDF link', async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    const invoiceId = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const creditNote = await seedInvoice(
      w,
      w.entityA,
      w.partyP,
      'issued',
      'credit_note',
      invoiceId,
    );
    const { documentId } = await renderPdf(scopeA, invoiceId);
    // What the render job stores on the original print (print 1), and a saved company profile.
    const format = {
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
      dateFormat: 'yyyy-MM-dd',
      capturedAt: '2026-11-01T06:15:00.000Z',
    };
    await withTx(db, scopeA, systemActor('invoice-render'), async (tx) => {
      await tx.insert(invoicePrintLog).values({
        tenantId: w.tenantId,
        organizationId: w.entityA,
        invoiceId,
        printNo: 1,
        printedBy: null,
        renderFormat: format,
      });
      await settings.set(tx, 'entity.profile', {
        displayName: 'Techrida',
        logoDocumentId: null,
        phones: ['+97715550100'],
        email: 'billing@techrida.example',
        website: 'https://techrida.example',
        panVatNo: null,
        signatoryName: 'Asha Shrestha',
        signatoryTitle: 'Director',
      });
    });
    current = customerOf(w, w.partyP);

    const list = z
      .array(PortalInvoiceListItemSchema)
      .parse((await get('/v1/portal/invoices')).body);
    expect(new Map(list.map((i) => [i.id, i.openAmount]))).toEqual(
      new Map([
        [invoiceId, '1130.00'],
        [creditNote, '0.00'],
      ]),
    );

    const viewRes = await get(`/v1/portal/invoices/${invoiceId}`);
    expect(viewRes.status, viewRes.text).toBe(200);
    const view = CustomerInvoiceViewSchema.parse(viewRes.body);
    expect(view).toMatchObject({
      id: invoiceId,
      kind: 'tax_invoice',
      issueDate: '2026-11-01',
      issueDateBs: '2083-07-15',
      dueDate: '2026-11-05',
      currency: 'NPR',
      seller: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address: 'Kathmandu' },
      lines: [
        {
          lineNo: 1,
          description: 'Solar panel',
          uom: 'pcs',
          quantity: '2',
          unitPrice: '500.00',
          amount: '1000.00',
        },
      ],
      totals: {
        subtotal: '1000.00',
        discountAmount: '0.00',
        taxableAmount: '1000.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        taxAmount: '130.00',
        total: '1130.00',
      },
      taxSummary: [{ label: 'VAT', percent: '13', base: '1000.00', tax: '130.00' }],
      format,
      // Only the four contact keys: no display name, logo or website.
      sellerContact: {
        phones: ['+97715550100'],
        email: 'billing@techrida.example',
        signatoryName: 'Asha Shrestha',
        signatoryTitle: 'Director',
      },
    });
    expect(Object.keys(view.sellerContact ?? {}).sort()).toEqual([
      'email',
      'phones',
      'signatoryName',
      'signatoryTitle',
    ]);
    expect(view.file?.documentId).toBe(documentId);
    expect(view.renderFailed).toBeUndefined();
    // The credit note was never printed: no stored format.
    const noteView = CustomerInvoiceViewSchema.parse(
      (await get(`/v1/portal/invoices/${creditNote}`)).body,
    );
    expect(noteView.format).toBeNull();

    const settlement = await get(`/v1/portal/invoices/${invoiceId}/settlement`);
    expect(settlement.status, settlement.text).toBe(200);
    expect(settlement.body).toEqual({
      invoiceId,
      currency: 'NPR',
      total: '1130.00',
      openAmount: '1130.00',
      dueDate: '2026-11-05',
      daysOverdue: 4,
      settlement: 'overdue',
    });
    const credit = await get(`/v1/portal/invoices/${creditNote}/settlement`);
    expect(credit.status, credit.text).toBe(200);
    expect(credit.body).toMatchObject({ openAmount: '0.00', settlement: 'credited' });

    const link = await get(`/v1/portal/invoices/${invoiceId}/document`);
    expect(link.status, link.text).toBe(200);
    expect(SignedLinkDtoSchema.parse(link.body).url).toMatch(SIGNED_PATH);
  });

  it('shows a pending PDF and answers 409 while there is no PDF yet or it awaits its scan', async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    const notRendered = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const quarantined = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    await renderPdf(scopeA, quarantined, { scan: false });
    current = customerOf(w, w.partyP);

    for (const id of [notRendered, quarantined]) {
      const view = CustomerInvoiceViewSchema.parse((await get(`/v1/portal/invoices/${id}`)).body);
      // No file data for a quarantined PDF, and not failed: the portal shows it as being prepared.
      expect(view.file).toBeNull();
      expect(view.renderFailed).toBeUndefined();
      const link = await get(`/v1/portal/invoices/${id}/document`);
      expect(link.status, link.text).toBe(409);
      expect(JSON.parse(link.text)).toEqual({
        error: {
          code: 'conflict',
          message: 'The PDF of this invoice is still being prepared',
          correlationId: REQUEST_ID,
        },
      });
    }
  });

  it('shows a failed PDF and answers 424 once the render was given up or the scan refused the file', async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    const givenUp = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    await giveUpRender(scopeA, givenUp);
    const infected = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    await setScanStatus(
      scopeA,
      (await renderPdf(scopeA, infected, { scan: false })).documentId,
      'infected',
    );
    const scanFailed = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    await setScanStatus(
      scopeA,
      (await renderPdf(scopeA, scanFailed, { scan: false })).documentId,
      'scan_failed',
    );
    current = customerOf(w, w.partyP);

    const bodies = new Set<string>();
    for (const [name, id] of Object.entries({ givenUp, infected, scanFailed })) {
      const viewRes = await get(`/v1/portal/invoices/${id}`);
      expect(viewRes.status, `${name}: ${viewRes.text}`).toBe(200);
      const view = CustomerInvoiceViewSchema.parse(viewRes.body);
      expect(view.file, name).toBeNull();
      expect(view.renderFailed, name).toBe(true);
      const link = await get(`/v1/portal/invoices/${id}/document`);
      expect(link.status, `${name}: ${link.text}`).toBe(424);
      bodies.add(link.text);
    }
    // One body for every failed PDF: no internal code tells a given-up render from a refused file.
    expect(bodies.size, [...bodies].join('\n')).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toEqual({
      error: {
        code: 'bad_request',
        message: 'The PDF could not be prepared',
        correlationId: REQUEST_ID,
      },
    });
  });

  it("answers another customer's failed invoice with the same plain 404 as an unknown id", async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    const failed = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    await giveUpRender(scopeA, failed);
    current = customerOf(w, w.partyQ);

    const unknown = randomUUID();
    for (const suffix of ['', '/document']) {
      const res = await get(`/v1/portal/invoices/${failed}${suffix}`);
      expect(res.status, `${suffix}: ${res.text}`).toBe(404);
      expect(res.text).toBe((await get(`/v1/portal/invoices/${unknown}${suffix}`)).text);
    }
    // Its owner does see it failed.
    current = customerOf(w, w.partyP);
    expect((await get(`/v1/portal/invoices/${failed}/document`)).status).toBe(424);
  });

  it('serves the clean original, not a newer PDF that is still awaiting its scan', async () => {
    const w = await seedWorld();
    const scopeA: TxScope = { tenantId: w.tenantId, organizationId: w.entityA };
    const invoiceId = await seedInvoice(w, w.entityA, w.partyP, 'issued');
    const original = await renderPdf(scopeA, invoiceId);
    await renderPdf(scopeA, invoiceId, { scan: false });
    current = customerOf(w, w.partyP);

    const view = CustomerInvoiceViewSchema.parse(
      (await get(`/v1/portal/invoices/${invoiceId}`)).body,
    );
    expect(view.file?.documentId).toBe(original.documentId);
    expect(view.renderFailed).toBeUndefined();
    const link = await get(`/v1/portal/invoices/${invoiceId}/document`);
    expect(link.status, link.text).toBe(200);
    expect(SignedLinkDtoSchema.parse(link.body).url).toMatch(SIGNED_PATH);
  });

  it('refuses a staff principal with 403 before any read', async () => {
    const w = await seedWorld();
    current = { ...customerOf(w, w.partyP), orgKind: 'staff', partyId: null };
    const res = await get('/v1/portal/invoices');
    expect(res.status).toBe(403);
  });
});
