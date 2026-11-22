// P4 Journey 11 over real HTTP, JWT verification, seeded production workflows, bos_app Postgres and BullMQ.
// Fake boundaries: Gotenberg returns a valid fixed PDF and clamd returns clean. Prerequisites seeded by
// p4-fixtures: approved vendor masters and ZITADEL identities. Every journey document is made through HTTP.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  ChainVerifyDtoSchema,
  ErrorBodySchema,
  SignedLinkDtoSchema,
  VendorBankAccountDtoSchema,
  VendorPortalBillViewSchema,
  VendorPortalPurchaseOrderListItemSchema,
  VendorPortalPurchaseOrderViewSchema,
  type ApprovalRequestDto,
} from '@bos/contracts';
import { createCompanyBankAccount, createExpenseAccount } from '@bos/db';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  onTestFailed,
} from 'vitest';

import type { PaymentRequestDto } from '../../src/modules/payables/payment-requests/payment-requests.service';
import type { VendorBillDto } from '../../src/modules/payables/bills/vendor-bills.service';
import type { PurchaseOrderDto } from '../../src/modules/procurement/orders/purchase-orders.service';
import { PurchaseOrderRenderSweeper } from '../../src/modules/procurement/orders/render/purchase-order-render.sweeper';
import type { ReceiptDto } from '../../src/modules/procurement/receipts/receipt.rules';
import type { PurchaseRequestDto } from '../../src/modules/procurement/requests/purchase-request.rules';
import type { QuotationDto, RfqDto } from '../../src/modules/procurement/sourcing/sourcing.service';
import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { startApp, type TestApp } from './support/app';
import { minimalPdf, pollUntil } from './support/fixtures';
import { seedP4World, type P4PersonaKey, type P4World } from './support/p4-fixtures';
import { startWorker, type TestWorker } from './support/worker';

const e2e = inject('e2e');
const PR = '/v1/procurement/purchase-requests';
const RFQ = '/v1/procurement/rfqs';
const PO = '/v1/procurement/purchase-orders';
const BILLS = '/v1/payables/bills';
const PAYMENTS = '/v1/payables/payment-requests';
const VP = '/v1/portal/vendor';
const SERIALS = ['J11-WORKSTATION-001', 'J11-ROUTER-002'];
// Separate VAT rounding per line: 100000 + 13000 + 6194.69 + 805.31 = exactly NPR 120000.
const PRICES = ['100000.00', '6194.69'];

let t: TestApp;
let worker: TestWorker;
let clamd: FakeClamd;
let gotenberg: Server;
let world: P4World;
let filesRoot: string;

const s = {
  pr: undefined as PurchaseRequestDto | undefined,
  rfq: undefined as RfqDto | undefined,
  po: undefined as PurchaseOrderDto | undefined,
  receipt: undefined as ReceiptDto | undefined,
  bill: undefined as VendorBillDto | undefined,
  payment: undefined as PaymentRequestDto | undefined,
  vat13: '',
  // Round 5 P1: bill lines and payment requests must name real company accounts of the entity.
  expenseAccountId: '',
  bankAccountId: '',
  quotationId: '',
  openItemId: '',
  invoiceSubmissionId: '',
  vendorAuth: '',
  otherVendorAuth: '',
};

const show = (res: { status: number; body: unknown }) =>
  `${res.status} ${JSON.stringify(res.body)}`;

function day(offset = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  clamd = await startFakeClamd();
  const pdf = minimalPdf();
  gotenberg = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      res.end(pdf);
    });
  });
  await new Promise<void>((resolve) => gotenberg.listen(0, '127.0.0.1', resolve));
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-p4-exit-'));
  world = await seedP4World(e2e);
  s.expenseAccountId = (await createExpenseAccount(world.pool, world.scope)).id;
  s.bankAccountId = (
    await createCompanyBankAccount(world.pool, { ...world.scope, currency: 'NPR' })
  ).id;
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-p4-exit.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-p4-exit-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: 'http://portal.e2e.test',
    GOTENBERG_URL: `http://127.0.0.1:${(gotenberg.address() as AddressInfo).port}`,
  });
  t = await startApp();
  worker = await startWorker();
  const vendor = world.vendors[0]!.login;
  const other = world.vendors[1]!.login;
  s.vendorAuth = `Bearer ${await t.token(vendor, { userId: vendor.sub, roles: ['vendor_user'] })}`;
  s.otherVendorAuth = `Bearer ${await t.token(other, { userId: other.sub, roles: ['vendor_user'] })}`;
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
  await clamd?.close();
  if (gotenberg) {
    await new Promise<void>((resolve) => {
      gotenberg.close(() => resolve());
      gotenberg.closeAllConnections();
    });
  }
  await world?.close();
  if (filesRoot) await rm(filesRoot, { recursive: true, force: true });
});

async function auth(key: P4PersonaKey): Promise<string> {
  const p = world.personas[key];
  return `Bearer ${await t.token(world.staff, { userId: p.sub, roles: p.tokenRoles })}`;
}

async function get<T>(path: string, authorization: string): Promise<T> {
  const res = await t.http().get(path).set('authorization', authorization);
  expect(res.status, `${path}: ${show(res)}`).toBe(200);
  return res.body as T;
}

async function post<T>(path: string, authorization: string, body: object = {}, status = 200) {
  const res = await t
    .http()
    .post(path)
    .set('authorization', authorization)
    .set('idempotency-key', randomUUID())
    .send(body);
  expect(res.status, `${path}: ${show(res)}`).toBe(status);
  return res.body as T;
}

async function request(id: string): Promise<ApprovalRequestDto> {
  return ApprovalRequestDtoSchema.parse(
    await get(`/v1/approvals/requests/${id}`, await auth('founder')),
  );
}

async function approve(id: string, key: P4PersonaKey): Promise<ApprovalRequestDto> {
  const before = await request(id);
  return ApprovalRequestDtoSchema.parse(
    await post(`/v1/approvals/requests/${id}/actions`, await auth(key), {
      action: 'approve',
      expectedVersion: before.version,
    }),
  );
}

async function refuseSelfApproval(id: string, key: P4PersonaKey) {
  const before = await request(id);
  const denied = await t
    .http()
    .post(`/v1/approvals/requests/${id}/actions`)
    .set('authorization', await auth(key))
    .set('idempotency-key', randomUUID())
    .send({ action: 'approve', expectedVersion: before.version });
  expect(denied.status, show(denied)).toBe(403);
  expect(ErrorBodySchema.parse(denied.body).error).toMatchObject({
    code: 'forbidden',
    reason: 'separation_of_duties',
  });
  expect(await request(id)).toMatchObject({
    status: 'pending',
    currentSeq: before.currentSeq,
    version: before.version,
  });
}

/** Staff officers get no general approval powers from another person's Department Head duty. */
async function refuseOfficerAccess(id: string, key: P4PersonaKey, expectedVersion: number) {
  const authorization = await auth(key);
  const detail = await t
    .http()
    .get(`/v1/approvals/requests/${id}`)
    .set('authorization', authorization);
  expect(detail.status, show(detail)).toBe(404);
  const action = await t
    .http()
    .post(`/v1/approvals/requests/${id}/actions`)
    .set('authorization', authorization)
    .set('idempotency-key', randomUUID())
    .send({ action: 'approve', expectedVersion });
  expect(action.status, show(action)).toBe(404);
}

/**
 * Someone who decided a step keeps reading the request after their step has moved on (commit 885f85a8, the
 * `tookPart` rule in requests.service.ts `eligibleRequest`, with U18-Q8 "past approvers keep seeing live context"),
 * so their reload of the request they just decided is a 200, not the 404 an officer outside the route still gets.
 * Reading grants nothing: deciding again is refused, and the request stays decided.
 */
async function expectPastApproverReadsButCannotAct(
  id: string,
  key: P4PersonaKey,
  expectedVersion: number,
) {
  const authorization = await auth(key);
  const detail = await t
    .http()
    .get(`/v1/approvals/requests/${id}`)
    .set('authorization', authorization);
  expect(detail.status, show(detail)).toBe(200);
  const read = ApprovalRequestDtoSchema.parse(detail.body);
  expect(read.status).toBe('approved');
  expect(read.steps[0]!.decidedBy).toBe(world.personas[key].userId);
  const action = await t
    .http()
    .post(`/v1/approvals/requests/${id}/actions`)
    .set('authorization', authorization)
    .set('idempotency-key', randomUUID())
    .send({ action: 'approve', expectedVersion });
  // Reading is all the rule grants: a second decision from a past approver is still refused as not found.
  expect(action.status, show(action)).toBe(404);
  const after = await t
    .http()
    .get(`/v1/approvals/requests/${id}`)
    .set('authorization', authorization);
  expect(after.status, show(after)).toBe(200);
  const unchanged = ApprovalRequestDtoSchema.parse(after.body);
  expect(unchanged.status).toBe('approved');
  expect(unchanged.version).toBe(read.version);
}

async function cleanDocument(documentId: string) {
  return pollUntil(
    `document ${documentId} to scan clean`,
    async () => {
      const { rows } = await world.pool.query<{ status: string; sha256: Buffer | null }>(
        `SELECT status, sha256 FROM app.document_versions
          WHERE tenant_id = $1 AND document_id = $2 ORDER BY version DESC LIMIT 1`,
        [world.tenantId, documentId],
      );
      const latest = rows[0];
      if (latest && ['infected', 'scan_failed', 'rejected'].includes(latest.status)) {
        throw new Error(`Journey document ended ${latest.status}`);
      }
      if (latest?.status === 'clean') {
        expect(Buffer.isBuffer(latest.sha256), 'Postgres SHA-256 bytea must be a Buffer').toBe(
          true,
        );
        expect(latest.sha256).toHaveLength(32);
        expect(latest.sha256!.equals(Buffer.alloc(32)), 'SHA-256 must not be an empty digest').toBe(
          false,
        );
        return { done: { ...latest, sha256: latest.sha256! }, last: latest };
      }
      return { done: undefined, last: latest };
    },
    60_000,
    250,
  );
}

/** Declare + stream + observe the real worker's scan; every consumer receives the producer's actual document id. */
async function upload(path: string, authorization: string, filename: string) {
  const pdf = minimalPdf();
  const created = await post<{ documentId: string; uploadPath: string }>(
    path,
    authorization,
    { filename, declaredMime: 'application/pdf', sizeBytes: pdf.length },
    201,
  );
  const sent = await t
    .http()
    .put(created.uploadPath)
    .set('authorization', authorization)
    .set('content-type', 'application/pdf')
    .set('content-length', String(pdf.length))
    .send(pdf);
  expect(sent.status, show(sent)).toBe(200);
  const clean = await cleanDocument(created.documentId);
  expect(clean.sha256).toEqual(createHash('sha256').update(pdf).digest());
  return created.documentId;
}

function quoteLines(prices = PRICES) {
  return s.pr!.lines.map((line, i) => ({
    prLineId: line.id,
    quantity: '1',
    unitPrice: prices[i]!,
    taxCodeId: s.vat13,
  }));
}

describe('P4 exit Journey 11: department request to approved payment request over HTTP', () => {
  let failedStep: string | undefined;
  beforeEach((context) => {
    if (failedStep) context.skip(`Journey prerequisite failed: ${failedStep}`);
    onTestFailed(() => {
      failedStep = context.task.name;
    });
  });

  it('1. submits a PR whose sole approval step is its Department Head', async () => {
    await t
      .http()
      .put('/v1/admin/settings/entity.address')
      .set('authorization', await auth('founder'))
      .send({ value: { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' } })
      .expect(200);
    const procurement = await auth('procurement');
    const codes = await get<{ id: string; code: string }[]>('/v1/tax-codes', procurement);
    s.vat13 = codes.find((c) => c.code === 'VAT13')!.id;
    expect(s.vat13, 'production seed VAT13').toBeTruthy();
    const requester = await auth('requester');
    const costCenters = await get<{ id: string; code: string; active: boolean }[]>(
      '/v1/cost-centers',
      requester,
    );
    const general = costCenters.find((center) => center.code === 'GENERAL' && center.active);
    expect(general, 'production seed GENERAL cost centre readable by the requester').toBeDefined();
    s.pr = await post<PurchaseRequestDto>(
      PR,
      requester,
      {
        requestType: 'goods',
        departmentId: world.departmentId,
        costCenterId: general!.id,
        justification: 'Replace the workstation and router for the IT department',
        requiredBy: day(14),
        budgetCode: 'J11-IT',
        currency: 'NPR',
        lines: ['Workstation', 'Router'].map((description, i) => ({
          description,
          uom: 'unit',
          quantity: '1',
          estimatedUnitPrice: PRICES[i],
          requiresSerials: true,
        })),
      },
      201,
    );
    s.pr = await post<PurchaseRequestDto>(`${PR}/${s.pr.id}/submit`, requester, {
      expectedVersion: s.pr.version,
    });
    expect(s.pr.status).toBe('submitted');
    const route = await request(s.pr.approvalRequestId!);
    expect(route.steps).toHaveLength(1);
    expect(route.steps[0]).toMatchObject({
      kind: 'department_head',
      userId: world.personas.departmentHead.userId,
      roleKey: null,
    });
    expect(route.steps.map((step) => step.roleKey)).not.toContain('accountant');
    expect(route.steps.map((step) => step.roleKey)).not.toContain('finance');
    expect(world.personas.departmentHead.tokenRoles).toEqual(['operations_officer']);
    const head = await auth('departmentHead');
    const inbox = await get<{ requestId: string }[]>('/v1/approvals/inbox', head);
    expect(inbox.map((item) => item.requestId)).toEqual([route.requestId]);
    const headDetail = ApprovalRequestDtoSchema.parse(
      await get(`/v1/approvals/requests/${route.requestId}`, head),
    );
    expect(headDetail.requestId).toBe(route.requestId);
    // The requester still has their ordinary own-record read, without gaining the right to approve it.
    expect(
      ApprovalRequestDtoSchema.parse(
        await get(`/v1/approvals/requests/${route.requestId}`, requester),
      ).requestId,
    ).toBe(route.requestId);
    const unrelatedInbox = await t
      .http()
      .get('/v1/approvals/inbox')
      .set('authorization', await auth('unrelatedOfficer'));
    expect(unrelatedInbox.status, show(unrelatedInbox)).toBe(403);
    await refuseOfficerAccess(route.requestId, 'unrelatedOfficer', headDetail.version);
    const selfAction = await t
      .http()
      .post(`/v1/approvals/requests/${route.requestId}/actions`)
      .set('authorization', requester)
      .set('idempotency-key', randomUUID())
      .send({ action: 'approve', expectedVersion: headDetail.version });
    expect(selfAction.status, show(selfAction)).toBe(404);

    const decisionKey = randomUUID();
    const decisionBody = { action: 'approve', expectedVersion: headDetail.version };
    let decided: ApprovalRequestDto | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = await t
        .http()
        .post(`/v1/approvals/requests/${route.requestId}/actions`)
        .set('authorization', head)
        .set('idempotency-key', decisionKey)
        .send(decisionBody);
      expect(decision.status, show(decision)).toBe(200);
      const result = ApprovalRequestDtoSchema.parse(decision.body);
      expect(result.status).toBe('approved');
      expect(result.steps[0]!.decidedBy).toBe(world.personas.departmentHead.userId);
      if (decided) expect(result).toEqual(decided);
      decided = result;
    }
    expect(await get('/v1/approvals/inbox', head)).toEqual([]);
    await expectPastApproverReadsButCannotAct(route.requestId, 'departmentHead', decided!.version);
    s.pr = await get<PurchaseRequestDto>(`${PR}/${s.pr.id}`, requester);
    expect(s.pr.status).toBe('dept_approved');
  });

  it('2. invites three approved vendors and converts a real portal quotation upload', async () => {
    const procurement = await auth('procurement');
    s.rfq = await post<RfqDto>(
      RFQ,
      procurement,
      {
        purchaseRequestId: s.pr!.id,
        deadline: `${day(7)}T12:00:00+05:45`,
        vendorIds: world.vendors.map((v) => v.id),
      },
      201,
    );
    expect(s.rfq.vendorIds.sort()).toEqual(world.vendors.map((v) => v.id).sort());
    const documentId = await upload(
      `${VP}/quotation-submissions/files`,
      s.vendorAuth,
      'journey-11-quotation.pdf',
    );
    const submission = await post<{ id: string }>(
      `${VP}/quotation-submissions`,
      s.vendorAuth,
      {
        rfqId: s.rfq.id,
        vendorRef: 'J11-Q-001',
        currency: 'NPR',
        total: '120000.00',
        documentId,
      },
      201,
    );
    const inbox = await get<{ id: string; scanStatus: string }[]>(
      `${RFQ}/${s.rfq.id}/submissions`,
      procurement,
    );
    expect(inbox).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: submission.id, scanStatus: 'clean' })]),
    );
    const converted = await post<QuotationDto>(
      `${RFQ}/${s.rfq.id}/quotations/convert`,
      procurement,
      { submissionId: submission.id, currency: 'NPR', lines: quoteLines() },
      201,
    );
    expect(converted).toMatchObject({
      vendorId: world.vendors[0]!.id,
      documentId,
      subtotal: '106194.69',
      taxAmount: '13805.31',
      total: '120000.00',
      totalNpr: '120000.00',
    });
    s.quotationId = converted.id;
    const { rows } = await world.pool.query<{ status: string }>(
      'SELECT status FROM app.vendor_quotation_submissions WHERE tenant_id = $1 AND id = $2',
      [world.tenantId, submission.id],
    );
    expect(rows).toEqual([{ status: 'converted' }]);
    // The other quotations are recorded by staff from scanned files, not portal bidding. Round 5 P2: staff upload
    // the scanned quote in place on the RFQ (owner type `evidence`); a vendor's inbox file is refused here.
    const vendorAuth = async (vendor: (typeof world.vendors)[number]) =>
      `Bearer ${await t.token(vendor.login, { userId: vendor.login.sub, roles: ['vendor_user'] })}`;
    const inboxFile = await upload(
      `${VP}/quotation-submissions/files`,
      await vendorAuth(world.vendors[1]!),
      'other-quote.pdf',
    );
    const refused = await t
      .http()
      .post(`${RFQ}/${s.rfq.id}/quotations`)
      .set('authorization', procurement)
      .set('idempotency-key', randomUUID())
      .send({
        vendorId: world.vendors[1]!.id,
        documentId: inboxFile,
        currency: 'NPR',
        lines: quoteLines(['110000.00', '7000.00']),
      });
    expect(refused.status, show(refused)).toBe(422);
    expect(ErrorBodySchema.parse(refused.body).error.code).toBe('invalid_evidence_document');
    for (const vendor of world.vendors.slice(1)) {
      const file = await upload(
        `${RFQ}/${s.rfq.id}/evidence-documents`,
        procurement,
        'scanned-quote.pdf',
      );
      await post<QuotationDto>(
        `${RFQ}/${s.rfq.id}/quotations`,
        procurement,
        {
          vendorId: vendor.id,
          documentId: file,
          currency: 'NPR',
          lines: quoteLines(['110000.00', '7000.00']),
        },
        201,
      );
    }
    const comparison = await get<QuotationDto[]>(`${RFQ}/${s.rfq.id}/quotations`, procurement);
    expect(comparison).toHaveLength(3);
    expect(new Set(comparison.map((q) => q.vendorId)).size).toBe(3);
    expect(comparison[0]!.id).toBe(s.quotationId);
  }, 120_000);

  it('3. the NPR 120000 gross commitment routes Accountant, Finance, Management; its recommender cannot approve', async () => {
    const procurement = await auth('procurement');
    s.rfq = await post<RfqDto>(`${RFQ}/${s.rfq!.id}/recommendation`, procurement, {
      vendorQuotationId: s.quotationId,
      rationale: 'Lowest compliant quote with the required warranty',
    });
    expect(s.rfq.fewerThanThreeReason).toBeNull();
    s.rfq = await post<RfqDto>(`${RFQ}/${s.rfq.id}/commitment`, procurement);
    const id = s.rfq.commitmentApprovalRequestId!;
    const route = await request(id);
    expect(route.steps.map((step) => step.roleKey)).toEqual([
      'accountant',
      'finance',
      'management',
    ]);
    // A PR head's exception does not extend to the commitment's Accountant/Finance/Management route.
    await refuseOfficerAccess(id, 'departmentHead', route.version);
    await refuseSelfApproval(id, 'procurement');
    for (const key of ['accountant', 'finance', 'management'] as const) await approve(id, key);
    expect((await request(id)).status).toBe('approved');
    const orders = await get<PurchaseOrderDto[]>(PO, procurement);
    const order = orders.find((po) => po.rfqId === s.rfq!.id);
    expect(order, 'commitment approval creates its draft PO').toBeDefined();
    s.po = await get<PurchaseOrderDto>(`${PO}/${order!.id}`, procurement);
    expect(s.po).toMatchObject({
      status: 'draft',
      approvedTotalNpr: '120000.00',
      approvedBand: 'management',
    });
  });

  it('4. issues the PO; the worker renders and scans its PDF and only its vendor can download it', async () => {
    s.po = await post<PurchaseOrderDto>(`${PO}/${s.po!.id}/issue`, await auth('procurement'));
    expect(s.po.status).toBe('issued');
    expect(s.po.lines).toHaveLength(2);
    expect(s.po.lines.every((line) => line.requiresSerials)).toBe(true);
    const sweep = await worker.app.get(PurchaseOrderRenderSweeper).sweep();
    expect(sweep.failures, JSON.stringify(sweep)).toEqual([]);
    const file = await pollUntil(
      'the issued PO PDF to scan clean',
      async () => {
        const view = VendorPortalPurchaseOrderViewSchema.parse(
          await get(`${VP}/purchase-orders/${s.po!.id}`, s.vendorAuth),
        );
        return { done: view.file ?? undefined, last: view };
      },
      60_000,
      250,
    );
    const scan = await cleanDocument(file.documentId);
    expect(scan.sha256.toString('hex')).toBe(file.sha256);
    const list = (await get<unknown[]>(`${VP}/purchase-orders`, s.vendorAuth)).map((row) =>
      VendorPortalPurchaseOrderListItemSchema.parse(row),
    );
    expect(list.map((row) => row.id)).toEqual([s.po.id]);
    const foreign = await t
      .http()
      .get(`${VP}/purchase-orders/${s.po.id}`)
      .set('authorization', s.otherVendorAuth);
    expect(foreign.status, show(foreign)).toBe(404);
    const foreignPdf = await t
      .http()
      .get(`${VP}/purchase-orders/${s.po.id}/pdf`)
      .set('authorization', s.otherVendorAuth);
    expect(foreignPdf.status, show(foreignPdf)).toBe(404);
    const link = SignedLinkDtoSchema.parse(
      await get(`${VP}/purchase-orders/${s.po.id}/pdf`, s.vendorAuth),
    );
    const downloaded = await t.http().get(new URL(link.url, 'http://api.e2e.test').pathname);
    expect(downloaded.status, show(downloaded)).toBe(200);
    expect(downloaded.headers['content-type']).toContain('application/pdf');
    expect(downloaded.body).toEqual(minimalPdf());
  }, 90_000);

  it('5. confirms the goods receipt with two serials and derives fully_received', async () => {
    const warehouse = await auth('warehouse');
    s.receipt = await post<ReceiptDto>(
      '/v1/procurement/receipts',
      warehouse,
      {
        purchaseOrderId: s.po!.id,
        kind: 'goods',
        receivedAt: day(),
        location: 'IT store',
        lines: s.po!.lines.map((line, i) => ({
          poLineId: line.id,
          quantity: '1',
          serials: [{ serialNo: SERIALS[i] }],
        })),
      },
      201,
    );
    s.receipt = await post<ReceiptDto>(
      `/v1/procurement/receipts/${s.receipt.id}/confirm`,
      warehouse,
    );
    expect(s.receipt.status).toBe('confirmed');
    expect(
      s.receipt.lines.flatMap((line) => line.serials.map((serial) => serial.serialNo)).sort(),
    ).toEqual([...SERIALS].sort());
    s.po = await get<PurchaseOrderDto>(`${PO}/${s.po!.id}`, await auth('procurement'));
    expect(s.po.status).toBe('fully_received');
  });

  it('6. converts the scanned portal invoice and matches it to the actual PO and receipt lines', async () => {
    const documentId = await upload(
      `${VP}/bill-submissions/files`,
      s.vendorAuth,
      'journey-11-invoice.pdf',
    );
    const submission = await post<{ id: string }>(
      `${VP}/bill-submissions`,
      s.vendorAuth,
      {
        purchaseOrderId: s.po!.id,
        vendorInvoiceNo: 'J11-INV-001',
        invoiceDate: day(),
        currency: 'NPR',
        claimedTotal: '120000.00',
        documentId,
      },
      201,
    );
    s.invoiceSubmissionId = submission.id;
    const enterer = await auth('enterer');
    const inbox = await get<{ id: string }[]>('/v1/payables/bill-submissions', enterer);
    expect(inbox.map((row) => row.id)).toContain(submission.id);
    s.bill = await post<VendorBillDto>(
      `/v1/payables/bill-submissions/${submission.id}/convert`,
      enterer,
      {
        lines: s.po!.lines.map((line) => ({
          poLineId: line.id,
          receiptLineId: s.receipt!.lines.find((receiptLine) => receiptLine.poLineId === line.id)!
            .id,
          accountId: s.expenseAccountId,
          quantity: '1',
          unitPrice: line.unitPrice,
          taxCodeId: s.vat13,
        })),
      },
      201,
    );
    expect(s.bill).toMatchObject({
      documentId,
      vendorPartyId: world.vendors[0]!.id,
      purchaseOrderId: s.po!.id,
      enteredBy: world.personas.enterer.userId,
      matchStatus: 'matched',
      payableTotal: '120000.00',
    });
    expect(s.bill.lines.every((line) => line.match?.status === 'matched')).toBe(true);
    const { rows } = await world.pool.query<{ status: string; converted_bill_id: string }>(
      'SELECT status, converted_bill_id FROM app.vendor_bill_submissions WHERE tenant_id = $1 AND id = $2',
      [world.tenantId, submission.id],
    );
    expect(rows).toEqual([{ status: 'converted', converted_bill_id: s.bill.id }]);
  }, 90_000);

  it('7. refuses the entering accountant, then an independent Accountant and Finance approve and post one payable', async () => {
    s.bill = await post<VendorBillDto>(`${BILLS}/${s.bill!.id}/submit`, await auth('enterer'));
    expect(s.bill.number).toMatch(/^BILL-\d{4}\/\d{2}-\d{5}$/);
    const id = s.bill.approvalRequestId!;
    expect((await request(id)).documentNumber).toBe(s.bill.number);
    expect((await request(id)).steps.map((step) => step.roleKey)).toEqual([
      'accountant',
      'finance',
    ]);
    await refuseSelfApproval(id, 'enterer');
    await approve(id, 'accountant');
    expect((await approve(id, 'finance')).status).toBe('approved');
    s.bill = await get<VendorBillDto>(`${BILLS}/${s.bill.id}`, await auth('accountant'));
    expect(s.bill).toMatchObject({
      status: 'approved',
      netTotal: '106194.69',
      vatTotal: '13805.31',
      tdsTotal: '0.00',
      payableTotal: '120000.00',
    });
    const { rows } = await world.pool.query<{
      id: string;
      side: string;
      vendor_party_id: string;
      amount: string;
    }>(
      `SELECT id, side, vendor_party_id, amount FROM app.open_items
        WHERE tenant_id = $1 AND organization_id = $2 AND source_type = 'vendor_bill' AND source_id = $3`,
      [world.tenantId, world.staff.organizationId, s.bill.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      side: 'payable',
      vendor_party_id: world.vendors[0]!.id,
      amount: s.bill.payableTotal,
    });
    s.openItemId = rows[0]!.id;
  });

  it('8. verifies the vendor bank account through maker-checker with scanned call-back evidence', async () => {
    const procurement = await auth('procurement');
    const bankPath = `/v1/vendors/${world.vendors[0]!.id}/bank-accounts`;
    const account = VendorBankAccountDtoSchema.parse(
      await post(
        bankPath,
        procurement,
        {
          bankName: 'Journey Bank',
          accountName: 'Journey 11 vendor 1',
          accountNumber: '001234567890',
        },
        201,
      ),
    );
    const evidence = await upload(
      `${bankPath}/${account.id}/evidence`,
      procurement,
      'callback-evidence.pdf',
    );
    const verified = VendorBankAccountDtoSchema.parse(
      await post(`${bankPath}/${account.id}/verify`, await auth('finance'), {
        callbackEvidenceDocumentId: evidence,
      }),
    );
    expect(verified).toMatchObject({ status: 'active', accountLast4: '7890' });
  }, 90_000);

  it('9. routes the payment to Finance only and excludes the requester, bill enterer and both bill approvers', async () => {
    const paymentRequester = await auth('paymentRequester');
    s.payment = await post<PaymentRequestDto>(
      PAYMENTS,
      paymentRequester,
      {
        vendorPartyId: world.vendors[0]!.id,
        paymentType: 'settlement',
        purchaseOrderId: s.po!.id,
        currency: 'NPR',
        fromBankAccountId: s.bankAccountId,
        allocations: [{ openItemId: s.openItemId, amount: s.bill!.payableTotal }],
      },
      201,
    );
    expect(s.payment).toMatchObject({
      status: 'draft',
      bankLast4: '7890',
      totalAmount: '120000.00',
    });
    s.payment = await post<PaymentRequestDto>(
      `${PAYMENTS}/${s.payment.id}/submit`,
      paymentRequester,
    );
    const id = s.payment.approvalRequestId!;
    const route = await request(id);
    expect(route.steps.map((step) => step.roleKey)).toEqual(['finance']);
    const excluded = ['paymentRequester', 'enterer', 'accountant', 'finance'] as const;
    const { rows } = await world.pool.query<{ sod_user_ids: string[] }>(
      'SELECT sod_user_ids FROM app.approval_requests WHERE tenant_id = $1 AND id = $2',
      [world.tenantId, id],
    );
    expect(rows[0]!.sod_user_ids).toEqual(
      expect.arrayContaining(excluded.map((key) => world.personas[key].userId)),
    );
    for (const key of excluded) await refuseSelfApproval(id, key);
    const approved = await approve(id, 'paymentApprover');
    expect(approved.status).toBe('approved');
    expect(approved.steps[0]!.decidedBy).toBe(world.personas.paymentApprover.userId);
    s.payment = await get<PaymentRequestDto>(`${PAYMENTS}/${s.payment.id}`, paymentRequester);
    expect(s.payment.status).toBe('approved');
  });

  it('10. proves final PO, payable balance, one vendor_bill_posted event, portal status, serials and audit chain', async () => {
    expect(
      (await get<PurchaseOrderDto>(`${PO}/${s.po!.id}`, await auth('procurement'))).status,
    ).toBe('fully_received');
    const { rows: balances } = await world.pool.query<{
      open_item_id: string;
      side: string;
      direction: string;
      customer_party_id: string | null;
      vendor_party_id: string;
      currency: string;
      amount: string;
      allocated_amount: string;
      open_amount: string;
    }>(
      `SELECT open_item_id, side, direction, customer_party_id, vendor_party_id, currency, amount, allocated_amount, open_amount
         FROM app.open_item_balances WHERE tenant_id = $1 AND organization_id = $2`,
      [world.tenantId, world.staff.organizationId],
    );
    expect(balances).toEqual([
      {
        open_item_id: s.openItemId,
        side: 'payable',
        direction: 'credit',
        customer_party_id: null,
        vendor_party_id: world.vendors[0]!.id,
        currency: 'NPR',
        amount: s.bill!.payableTotal,
        allocated_amount: '0.00',
        open_amount: s.bill!.payableTotal,
      },
    ]);
    const { rows: events } = await world.pool.query<{ event: string; payload: unknown }>(
      `SELECT event, payload FROM app.posting_events
        WHERE tenant_id = $1 AND organization_id = $2 AND source_type = 'vendor_bill' AND source_id = $3`,
      [world.tenantId, world.staff.organizationId, s.bill!.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'vendor_bill_posted',
      payload: {
        openItemId: s.openItemId,
        vendorPartyId: world.vendors[0]!.id,
        currency: 'NPR',
        netTotal: '106194.69',
        vatTotal: '13805.31',
        tdsTotal: '0.00',
        payableTotal: '120000.00',
      },
    });
    const view = VendorPortalBillViewSchema.parse(
      await get(`${VP}/bills/${s.bill!.id}`, s.vendorAuth),
    );
    expect(view).toMatchObject({
      number: s.bill!.number,
      status: 'approved_for_payment',
      payableTotal: '120000.00',
      payments: [],
    });
    const foreign = await t
      .http()
      .get(`${VP}/bills/${s.bill!.id}`)
      .set('authorization', s.otherVendorAuth);
    expect(foreign.status, show(foreign)).toBe(404);
    const { rows: serials } = await world.pool.query<{ serial_no: string }>(
      `SELECT s.serial_no FROM app.receipt_serials s JOIN app.receipt_lines l
          ON l.tenant_id = s.tenant_id AND l.organization_id = s.organization_id AND l.id = s.receipt_line_id
        WHERE s.tenant_id = $1 AND s.organization_id = $2 AND l.receipt_id = $3 ORDER BY s.serial_no`,
      [world.tenantId, world.staff.organizationId, s.receipt!.id],
    );
    expect(serials.map((serial) => serial.serial_no)).toEqual([...SERIALS].sort());
    const month = new Date().toISOString().slice(0, 7);
    const verify = await t
      .http()
      .get('/v1/audit/verify')
      .query({ month })
      .set('authorization', await auth('finance'));
    expect(verify.status, show(verify)).toBe(200);
    const chain = ChainVerifyDtoSchema.parse(verify.body);
    expect(chain).toMatchObject({ tenantId: world.tenantId, month, ok: true, firstBadSeq: null });
    expect(chain.rows).toBeGreaterThan(0);
  });
});
