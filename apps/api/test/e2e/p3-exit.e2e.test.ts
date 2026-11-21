// P3 exit test (P3-BUILD-PLAN done check 13) over real HTTP: a quote accepted in the portal becomes a sales order split
// 60/20/20; the advance invoice is drafted, submitted, approved by finance alone (F1-Q30) and issued; the render sweeper
// renders its PDF and the scan marks it clean; the customer sees it in the portal and uploads proof of payment; a
// different Finance user verifies the payment and allocates it with an excess, which shows as the customer's advance;
// the milestone invoice is issued; a partial credit note is issued on it; aging equals the open receivable total and
// the audit chain verifies.
//
// Real: AppModule and WorkerModule (startApp, startWorker), the JwtVerifier against the test issuer, Postgres as
// bos_app, the production seed (role grants, workflows, VAT13), the quotation and invoice render sweepers as the worker
// wires them, the BullMQ scan processor (quotation PDF, invoice PDF, the customer's proof). Faked: Gotenberg (an HTTP
// server answering a fixed PDF) and clamd (the fake the documents tests use).
// Shortcuts, each declared where it is taken:
// - the customer's portal login is seeded by SQL (seedPortalLogin), as in p2-exit;
// - both render sweepers are run through the worker's own instance instead of waiting for their schedule.
//
// Separation of duties shapes the cast (support/p3-fixtures.ts): `preparer` (accountant role) prepares, `accountant`
// and `finance` approve, `finance` issues, `finance2` drafts the credit note and verifies and allocates the payment.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AllocationDtoSchema,
  ApprovalRequestDtoSchema,
  ArAgingReportSchema,
  ChainVerifyDtoSchema,
  CustomerAdvanceSchema,
  CustomerInvoiceViewSchema,
  ErrorBodySchema,
  InvoiceDetailSchema,
  InvoiceSettlementSchema,
  IssueInvoiceResultSchema,
  LeadDtoSchema,
  PaymentDtoSchema,
  PortalInvoiceListItemSchema,
  PortalPaymentListItemSchema,
  QuotationDtoSchema,
  QuotationVersionDtoSchema,
  SalesOrderDetailSchema,
  SignedLinkDtoSchema,
  type InvoiceDetail,
  type InvoiceSettlement,
  type SalesOrderDetail,
} from '@bos/contracts';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { InvoiceRenderSweeper } from '../../src/modules/invoices/render/invoice-render.sweeper';
import { QuotationRenderSweeper } from '../../src/modules/quotations/render/quotation-render.sweeper';
import { CLIENT_ID, startApp, type TestApp } from './support/app';
import { minimalPdf, pollUntil, seedPortalLogin, type PortalLogin } from './support/fixtures';
import { seedP3World, type P3PersonaKey, type P3World } from './support/p3-fixtures';
import { startWorker, type TestWorker } from './support/worker';

const e2e = inject('e2e');

const ADDRESS = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const BUYER_EMAIL = 'buyer@annapurna-retail.test';
// Done check 1's golden order: 4,465,000.00 + VAT 13% = 5,045,450.00, split 60/20/20 by the default schedule.
const LINE_PRICE = '4465000.00';
const ORDER_TOTAL = '5045450.00';
const SPLIT = ['3027270.00', '1009090.00', '1009090.00'];
const PAID = '3100000.00';
const EXCESS = '72730.00';

let t: TestApp;
let worker: TestWorker;
let clamd: FakeClamd;
let gotenberg: Server;
let world: P3World;
let filesRoot: string;
const pdf = minimalPdf();

const kathmanduDay = (shiftDays = 0): string => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  clamd = await startFakeClamd();
  gotenberg = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      res.end(pdf);
    });
  });
  await new Promise<void>((resolve) => gotenberg.listen(0, '127.0.0.1', resolve));
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-p3-exit-'));

  world = await seedP3World(e2e, 'e2e-p3-exit');

  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-p3-exit.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-p3-exit-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: 'http://portal.e2e.test',
    GOTENBERG_URL: `http://127.0.0.1:${(gotenberg.address() as AddressInfo).port}`,
  });
  t = await startApp();
  worker = await startWorker();
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

// ------------------------------------------------------------------------------------------------ helpers

async function auth(key: P3PersonaKey): Promise<string> {
  const persona = world.personas[key];
  const token = await t.token(world.isolated.staff, {
    userId: persona.sub,
    roles: persona.tokenRoles,
  });
  return `Bearer ${token}`;
}

async function portalAuth(login: PortalLogin): Promise<string> {
  const token = await t.token(
    { zitadelOrgId: login.zitadelOrgId },
    { userId: login.sub, roles: ['customer_user'] },
  );
  return `Bearer ${token}`;
}

const show = (res: { status: number; body: unknown }): string =>
  `${res.status} ${JSON.stringify(res.body)}`;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The approver persona of each role a route can name. The preparer is never one: they drafted. */
const APPROVER_OF: Partial<Record<string, P3PersonaKey>> = {
  accountant: 'accountant',
  finance: 'finance',
  management: 'management',
  founder: 'founder',
};

/**
 * Walks an approval request to `approved`, one step at a time, each by the persona of the step's role. The founder step
 * needs a fresh ID token (step-up), as p2-exit step 5 proves; it is attached only there. Returns the roles in order.
 */
async function approveAll(requestId: string): Promise<string[]> {
  const reader = await auth('founder');
  const decided: string[] = [];
  for (let guard = 0; guard < 8; guard += 1) {
    const got = await t
      .http()
      .get(`/v1/approvals/requests/${requestId}`)
      .set('authorization', reader);
    expect(got.status, show(got)).toBe(200);
    const request = ApprovalRequestDtoSchema.parse(got.body);
    if (request.status === 'approved') return decided;
    expect(request.status, show(got)).toBe('pending');
    const step = request.steps.find((st) => st.seq === request.currentSeq);
    const key = step?.roleKey == null ? undefined : APPROVER_OF[step.roleKey];
    expect(key, `no approver persona for step ${JSON.stringify(step)}`).toBeDefined();
    const headers: Record<string, string> = {};
    if (key === 'founder') {
      headers['x-bos-id-token'] = await t.issuer.mintIdToken({
        sub: world.personas.founder.sub,
        authTime: nowSeconds() - 10,
        audience: CLIENT_ID,
      });
    }
    const res = await t
      .http()
      .post(`/v1/approvals/requests/${requestId}/actions`)
      .set('authorization', await auth(key!))
      .set('idempotency-key', randomUUID())
      .set(headers)
      .send({ action: 'approve', expectedVersion: request.version });
    expect(res.status, `${key} approving: ${show(res)}`).toBe(200);
    decided.push(step!.roleKey!);
  }
  throw new Error(`approval request ${requestId} did not reach approved`);
}

async function getInvoice(id: string, as: P3PersonaKey = 'finance'): Promise<InvoiceDetail> {
  const res = await t
    .http()
    .get(`/v1/invoices/${id}`)
    .set('authorization', await auth(as));
  expect(res.status, show(res)).toBe(200);
  return InvoiceDetailSchema.parse(res.body);
}

async function getOrder(): Promise<SalesOrderDetail> {
  const res = await t
    .http()
    .get(`/v1/sales-orders/${s.orderId}`)
    .set('authorization', await auth('preparer'));
  expect(res.status, show(res)).toBe(200);
  return SalesOrderDetailSchema.parse(res.body);
}

// F1-Q30 (migration 0110): an invoice drafted from an approved billing schedule needs Finance only; a credit or debit
// note keeps Accountant then Finance. The advance and the milestone here are schedule invoices.
const SCHEDULE_INVOICE_ROUTE = ['finance'];
const NOTE_ROUTE = ['accountant', 'finance'];

/** Submit by the preparer (or `submitter`), approve along `route`, issue by finance. Returns the number. */
async function submitApproveIssue(
  invoiceId: string,
  submitter: P3PersonaKey = 'preparer',
  route: string[] = SCHEDULE_INVOICE_ROUTE,
): Promise<string> {
  const draft = await getInvoice(invoiceId, submitter);
  const submitted = await t
    .http()
    .post(`/v1/invoices/${invoiceId}/submit`)
    .set('authorization', await auth(submitter))
    .set('idempotency-key', randomUUID())
    .send({ expectedVersion: draft.invoice.version });
  expect(submitted.status, show(submitted)).toBe(200);
  const sub = InvoiceDetailSchema.parse(submitted.body).invoice;
  expect(sub.status).toBe('submitted');
  expect(sub.approvalRequestId).not.toBeNull();

  // A schedule invoice: Finance alone. A note: Accountant -> Finance, two distinct users, neither the submitter.
  expect(await approveAll(sub.approvalRequestId!)).toEqual(route);
  const approved = await getInvoice(invoiceId);
  expect(approved.invoice.status).toBe('approved');

  const issued = await t
    .http()
    .post(`/v1/invoices/${invoiceId}/issue`)
    .set('authorization', await auth('finance'))
    .set('idempotency-key', randomUUID())
    .send({ expectedVersion: approved.invoice.version });
  expect(issued.status, show(issued)).toBe(200);
  const result = IssueInvoiceResultSchema.parse(issued.body);
  expect(result.kind).toBe('issued');
  return result.number;
}

async function statement(open: boolean): Promise<InvoiceSettlement[]> {
  const res = await t
    .http()
    .get(`/v1/receivables/customers/${s.customerId}/statement`)
    .query({ open: String(open), currency: 'NPR' })
    .set('authorization', await auth('finance'));
  expect(res.status, show(res)).toBe(200);
  return (res.body as unknown[]).map((r) => InvoiceSettlementSchema.parse(r));
}

const settlementOf = async (invoiceId: string): Promise<InvoiceSettlement> => {
  const row = (await statement(false)).find((r) => r.invoiceId === invoiceId);
  expect(row, `no settlement row for ${invoiceId}`).toBeDefined();
  return row!;
};

async function versionStatus(versionId: string): Promise<string | undefined> {
  const { rows } = await world.pool.query<{ status: string }>(
    'SELECT status FROM app.document_versions WHERE id = $1',
    [versionId],
  );
  return rows[0]?.status;
}

// ------------------------------------------------------------------------------------------- the journey

const s = {
  customerId: '',
  contactId: '',
  opportunityId: '',
  quotationId: '',
  versionId: '',
  orderId: '',
  scheduleLineIds: [] as string[],
  advanceId: '',
  milestoneId: '',
  creditNoteId: '',
  paymentId: '',
  /** The customer's bank slip (a `payment_intake` file): never evidence of the order. */
  proofDocumentId: '',
  login: undefined as PortalLogin | undefined,
};

describe('P3 exit: quote to cash over HTTP', () => {
  it('0. the founder sets the entity address', async () => {
    const res = await t
      .http()
      .put('/v1/admin/settings/entity.address')
      .set('authorization', await auth('founder'))
      .send({ value: ADDRESS });
    expect([200, 204], show(res)).toContain(res.status);
  });

  it('1. sales converts a lead into a customer and drafts an NPR quotation for 5,045,450.00', async () => {
    const sales = await auth('sales');
    const created = await t.http().post('/v1/leads').set('authorization', sales).send({
      title: 'Store platform for Annapurna Retail',
      source: 'referral',
      companyName: 'Annapurna Retail Pvt. Ltd.',
      contactName: 'Hari Gurung',
      email: BUYER_EMAIL,
    });
    expect(created.status, show(created)).toBe(201);
    let lead = LeadDtoSchema.parse(created.body);
    for (const stage of ['contacted', 'qualified'] as const) {
      const moved = await t
        .http()
        .patch(`/v1/leads/${lead.id}/stage`)
        .set('authorization', sales)
        .send({
          stage,
          expectedVersion: lead.version,
          ...(stage === 'contacted'
            ? { contactActivity: { kind: 'call', body: 'Intro call' } }
            : {}),
        });
      expect(moved.status, show(moved)).toBe(200);
      lead = LeadDtoSchema.parse(moved.body);
    }
    const converted = await t
      .http()
      .post(`/v1/leads/${lead.id}/convert`)
      .set('authorization', sales)
      .set('idempotency-key', randomUUID())
      .send({
        customer: {
          mode: 'create',
          customer: { legalName: 'Annapurna Retail Pvt. Ltd.', address: ADDRESS },
        },
        contact: { mode: 'create', contact: { fullName: 'Hari Gurung', email: BUYER_EMAIL } },
        opportunityName: 'Annapurna store platform',
        expectedVersion: lead.version,
      });
    expect(converted.status, show(converted)).toBe(201);
    const ids = converted.body as { opportunityId: string; customerId: string };
    s.opportunityId = ids.opportunityId;
    s.customerId = ids.customerId;
    const contacts = await t
      .http()
      .get(`/v1/customers/${s.customerId}/contacts`)
      .set('authorization', sales);
    expect(contacts.status, show(contacts)).toBe(200);
    s.contactId = (contacts.body as { id: string }[])[0]!.id;

    const codes = await t.http().get('/v1/tax-codes').set('authorization', sales);
    expect(codes.status, show(codes)).toBe(200);
    const codeList = (
      Array.isArray(codes.body) ? codes.body : (codes.body as { items: unknown[] }).items
    ) as { id: string; code: string }[];
    const vat13 = codeList.find((c) => c.code === 'VAT13');
    expect(vat13, 'the production seed gives the tenant VAT13').toBeDefined();

    // No paymentSchedule: plan A7's default 60/20/20 (advance, milestone, UAT) applies.
    const quote = await t
      .http()
      .post('/v1/quotations')
      .set('authorization', sales)
      .set('idempotency-key', randomUUID())
      .send({
        opportunityId: s.opportunityId,
        contactId: s.contactId,
        currency: 'NPR',
        issueDate: kathmanduDay(),
        validUntil: kathmanduDay(30),
        lines: [
          {
            description: 'Store platform build',
            uom: 'lot',
            quantity: '1',
            unitPrice: LINE_PRICE,
            taxCodeId: vat13!.id,
          },
        ],
      });
    expect(quote.status, show(quote)).toBe(201);
    const q = QuotationDtoSchema.parse(quote.body);
    s.quotationId = q.id;
    s.versionId = q.currentVersionId;
  });

  it('2. the quotation is approved, rendered, scanned clean, sent and accepted in the portal', async () => {
    const sales = await auth('sales');
    const versionPath = `/v1/quotations/${s.quotationId}/versions/${s.versionId}`;
    const getVersion = async () => {
      const res = await t.http().get(versionPath).set('authorization', sales);
      expect(res.status, show(res)).toBe(200);
      return QuotationVersionDtoSchema.parse(res.body);
    };

    const submitted = await t
      .http()
      .post(`${versionPath}/submit`)
      .set('authorization', sales)
      .set('idempotency-key', randomUUID())
      .send({ expectedVersion: (await getVersion()).version });
    expect(submitted.status, show(submitted)).toBe(200);
    const requestId = QuotationVersionDtoSchema.parse(submitted.body).approvalRequestId!;
    await approveAll(requestId);
    expect((await getVersion()).status).toBe('approved');

    const swept = await worker.app.get(QuotationRenderSweeper).sweep();
    expect(swept.failures, JSON.stringify(swept)).toEqual([]);
    await pollUntil(
      'the quotation PDF to scan clean',
      async () => {
        const v = await getVersion();
        if (v.renderedScanStatus === 'infected' || v.renderedScanStatus === 'scan_failed') {
          throw new Error(`the quotation PDF scan ended ${v.renderedScanStatus}`);
        }
        return { done: v.renderedScanStatus === 'clean' ? v : undefined, last: v };
      },
      60_000,
      500,
    );

    const sent = await t
      .http()
      .post(`${versionPath}/send`)
      .set('authorization', sales)
      .set('idempotency-key', randomUUID())
      .send({ recipientContactId: s.contactId, expectedVersion: (await getVersion()).version });
    expect(sent.status, show(sent)).toBe(200);

    // SHORTCUT (as p2-exit): the portal login is seeded by SQL.
    s.login = await seedPortalLogin(e2e, world.scope, s.customerId);
    const accepted = await t
      .http()
      .post(`/v1/portal/quotations/${s.versionId}/accept`)
      .set('authorization', await portalAuth(s.login))
      .set('idempotency-key', randomUUID())
      .send({ acceptedByName: 'Hari Gurung', confirm: true });
    expect(accepted.status, show(accepted)).toBe(201);
    expect((await getVersion()).status).toBe('accepted');
  }, 120_000);

  it('3. the accepted quote becomes a sales order split 60/20/20 (3,027,270.00 / 1,009,090.00 / 1,009,090.00)', async () => {
    // F1-Q28: Sales confirm the evidence of the portal acceptance first. The typed name is a signed quote, which meets
    // the default evidence policy: no extra file.
    const evidence = await t
      .http()
      .post(`/v1/quotations/${s.quotationId}/versions/${s.versionId}/evidence-confirmation`)
      .set('authorization', await auth('sales'))
      .set('idempotency-key', randomUUID())
      .send({ evidenceKinds: ['signed_quote'] });
    expect(evidence.status, show(evidence)).toBe(201);
    expect(evidence.body).toMatchObject({ status: 'confirmed' });
    // F1-Q25: the acceptance drafted the order; the Accountant's confirm below promotes that draft.
    const res = await t
      .http()
      .post('/v1/sales-orders')
      .set('authorization', await auth('preparer'))
      .set('idempotency-key', randomUUID())
      .send({ quotationVersionId: s.versionId });
    expect(res.status, show(res)).toBe(201);
    const detail = SalesOrderDetailSchema.parse(res.body);
    s.orderId = detail.order.id;
    expect(detail.order).toMatchObject({
      status: 'confirmed',
      customerId: s.customerId,
      currency: 'NPR',
    });
    expect(detail.order.totals.total).toBe(ORDER_TOTAL);
    const schedule = [...detail.schedule].sort((a, b) => a.seq - b.seq);
    expect(schedule.map((l) => [l.trigger, Number(l.percent), l.amount])).toEqual([
      ['advance', 60, SPLIT[0]],
      ['milestone', 20, SPLIT[1]],
      ['uat', 20, SPLIT[2]],
    ]);
    s.scheduleLineIds = schedule.map((l) => l.id);
    expect(detail.deliveryReleased).toBe(false);
  });

  it('4. the advance invoice is drafted, submitted, approved by finance alone (F1-Q30) and issued', async () => {
    const preparer = await auth('preparer');
    let order = await getOrder();
    const advance = order.schedule.find((l) => l.id === s.scheduleLineIds[0])!;
    if (advance.status === 'planned') {
      // An advance needs no evidence to become billable.
      const marked = await t
        .http()
        .post(`/v1/sales-orders/${s.orderId}/schedule-lines/${advance.id}/mark-billable`)
        .set('authorization', preparer)
        .set('idempotency-key', randomUUID())
        .send({ expectedVersion: order.order.version });
      expect(marked.status, show(marked)).toBe(201);
      order = SalesOrderDetailSchema.parse(marked.body);
    }

    const drafted = await t
      .http()
      .post('/v1/invoices/from-schedule')
      .set('authorization', preparer)
      .set('idempotency-key', randomUUID())
      .send({ scheduleLineId: advance.id });
    expect(drafted.status, show(drafted)).toBe(201);
    const draft = InvoiceDetailSchema.parse(drafted.body).invoice;
    expect(draft).toMatchObject({ kind: 'tax_invoice', status: 'draft', number: null });
    expect(draft.totals.total).toBe(SPLIT[0]);
    s.advanceId = draft.id;

    const number = await submitApproveIssue(s.advanceId);
    expect(number).toMatch(/^INV-\d{4}\/\d{2}-\d{5}$/);
    const issued = await getInvoice(s.advanceId);
    expect(issued.invoice).toMatchObject({ status: 'issued', number });
  });

  it('5. the render sweeper renders the advance PDF (fake Gotenberg) and the scan marks it clean (fake clamd)', async () => {
    const finance = await auth('finance');
    // Before the scan no unscanned file is ever linked: the route answers 409 while the PDF is being prepared or
    // scanned (TR-Q4, R4c2; the screen shows "Preparing PDF"), or 404 before any render exists. A given-up render is 424
    // and fails the wait at once; a scan-refused file is also a plain 404 on the wire, so only the 60 s timeout ends it.
    const link = await pollUntil(
      'the advance invoice PDF to scan clean',
      async () => {
        // Earlier files leave issued invoices in the shared database. Drive bounded passes until this
        // invoice reaches the batch instead of assuming one pass includes it or waiting for the timer.
        const swept = await worker.app.get(InvoiceRenderSweeper).sweep();
        expect(swept.failures, JSON.stringify(swept)).toEqual([]);
        const res = await t
          .http()
          .get(`/v1/invoices/${s.advanceId}/document`)
          .set('authorization', finance);
        // The service tags the 409 `invoice_pdf_not_ready`, but the error filter only keeps codes on its allowlist (it has
        // `quotation_pdf_not_ready`, not the invoice one), so the wire code is `conflict`: match the 409 by its message.
        const error = (res.body as { error?: { code?: string; message?: string } }).error;
        const waiting =
          (res.status === 409 &&
            error?.message === 'The PDF of this invoice is still being prepared') ||
          (res.status === 404 && error?.code === 'not_found');
        if (res.status !== 200 && !waiting) throw new Error(show(res));
        const body = res.body as unknown;
        return {
          done: res.status === 200 ? SignedLinkDtoSchema.parse(body) : undefined,
          last: show(res),
        };
      },
      60_000,
      500,
    );
    expect(link.url).toBeTruthy();
  }, 90_000);

  it('6. the customer sees the issued advance in the portal, with its clean file', async () => {
    const authz = await portalAuth(s.login!);
    const list = await t.http().get('/v1/portal/invoices').set('authorization', authz);
    expect(list.status, show(list)).toBe(200);
    const items = (list.body as unknown[]).map((i) => PortalInvoiceListItemSchema.parse(i));
    expect(items.map((i) => [i.id, i.total, i.openAmount])).toEqual([
      [s.advanceId, SPLIT[0], SPLIT[0]],
    ]);

    const view = await t
      .http()
      .get(`/v1/portal/invoices/${s.advanceId}`)
      .set('authorization', authz);
    expect(view.status, show(view)).toBe(200);
    const customerView = CustomerInvoiceViewSchema.parse(view.body);
    expect(customerView.totals.total).toBe(SPLIT[0]);
    expect(customerView.file?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const doc = await t
      .http()
      .get(`/v1/portal/invoices/${s.advanceId}/document`)
      .set('authorization', authz);
    expect(doc.status, show(doc)).toBe(200);
  });

  it('7. the customer uploads a bank slip through the portal proof route and submits a payment of 3,100,000.00', async () => {
    const authz = await portalAuth(s.login!);
    const declared = await t
      .http()
      .post('/v1/portal/payment-proofs')
      .set('authorization', authz)
      .send({ filename: 'bank-slip.pdf', declaredMime: 'application/pdf', sizeBytes: pdf.length });
    expect(declared.status, show(declared)).toBe(201);
    const proof = declared.body as { documentId: string; versionId: string; uploadPath: string };
    s.proofDocumentId = proof.documentId;

    const put = await t
      .http()
      .put(proof.uploadPath)
      .set('authorization', authz)
      .set('content-type', 'application/pdf')
      .send(pdf);
    expect([200, 201], show(put)).toContain(put.status);

    // The worker's scan processor clears the slip (fake clamd); a payment names only clean proofs.
    await pollUntil(
      'the bank slip to scan clean',
      async () => {
        const status = await versionStatus(proof.versionId);
        if (status === 'infected' || status === 'scan_failed') {
          throw new Error(`the slip scan ended ${status}`);
        }
        return { done: status === 'clean' ? status : undefined, last: status };
      },
      60_000,
      300,
    );

    const submitted = await t
      .http()
      .post('/v1/portal/payments')
      .set('authorization', authz)
      .set('idempotency-key', randomUUID())
      .send({
        currency: 'NPR',
        amount: PAID,
        method: 'bank_transfer',
        receivedOn: kathmanduDay(),
        bankReference: 'NABIL-0042',
        proofDocumentIds: [proof.documentId],
      });
    expect(submitted.status, show(submitted)).toBe(201);
    const item = PortalPaymentListItemSchema.parse(submitted.body);
    expect(item).toMatchObject({ status: 'submitted', amount: PAID, number: null });
    s.paymentId = item.id;
  }, 90_000);

  it('8. a different Finance user verifies it; verifying alone leaves the advance unpaid', async () => {
    const finance2 = await auth('finance2');
    const got = await t.http().get(`/v1/payments/${s.paymentId}`).set('authorization', finance2);
    expect(got.status, show(got)).toBe(200);
    const before = PaymentDtoSchema.parse(got.body);

    const verified = await t
      .http()
      .post(`/v1/payments/${s.paymentId}/verify`)
      .set('authorization', finance2)
      .set('idempotency-key', randomUUID())
      .send({ expectedVersion: before.version });
    expect(verified.status, show(verified)).toBe(200);
    const payment = PaymentDtoSchema.parse(verified.body);
    expect(payment.status).toBe('verified');
    expect(payment.verifiedBy).toBe(world.personas.finance2.userId);
    expect(payment.number).toMatch(/^RCPT-/);

    // Done check 8: paid is derived from allocations, so a verified payment alone settles nothing.
    expect((await settlementOf(s.advanceId)).openAmount).toBe(SPLIT[0]);
  });

  it('9. finance2 allocates the advance in full; the excess 72,730.00 shows as the customer’s advance', async () => {
    const res = await t
      .http()
      .post(`/v1/payments/${s.paymentId}/allocations`)
      .set('authorization', await auth('finance2'))
      .set('idempotency-key', randomUUID())
      .send({ lines: [{ invoiceId: s.advanceId, amount: SPLIT[0] }] });
    expect(res.status, show(res)).toBe(201);
    const rows = (res.body as unknown[]).map((r) => AllocationDtoSchema.parse(r));
    expect(rows.map((r) => [r.invoiceId, r.paymentId, r.amount])).toEqual([
      [s.advanceId, s.paymentId, SPLIT[0]],
    ]);

    const settled = await settlementOf(s.advanceId);
    expect(settled).toMatchObject({ openAmount: '0.00', settlement: 'paid' });

    const adv = await t
      .http()
      .get(`/v1/receivables/customers/${s.customerId}/advance`)
      .set('authorization', await auth('finance'));
    expect(adv.status, show(adv)).toBe(200);
    const advances = (adv.body as unknown[]).map((a) => CustomerAdvanceSchema.parse(a));
    expect(advances).toEqual([{ customerId: s.customerId, currency: 'NPR', amount: EXCESS }]);

    // Plan A14: the advance has nothing open, so delivery is released.
    expect((await getOrder()).deliveryReleased).toBe(true);
  });

  it('10. the milestone line is marked billable with evidence, and its invoice is issued after finance approves it', async () => {
    const preparer = await auth('preparer');
    // Round 5 P2: the evidence is uploaded in place on the order (owner type `evidence`) by the preparer, who holds
    // sales_order.mark_billable and no documents.upload; Mark billable takes only a file of this order.
    const declared = await t
      .http()
      .post(`/v1/sales-orders/${s.orderId}/evidence-documents`)
      .set('authorization', preparer)
      .send({
        filename: 'uat-signoff.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: pdf.length,
      });
    expect(declared.status, show(declared)).toBe(201);
    const evidence = declared.body as { documentId: string; versionId: string; uploadPath: string };
    expect(evidence.uploadPath).toBe(
      `/v1/sales-orders/${s.orderId}/evidence-documents/${evidence.documentId}/versions/${evidence.versionId}/content`,
    );
    const put = await t
      .http()
      .put(evidence.uploadPath)
      .set('authorization', preparer)
      .set('content-type', 'application/pdf')
      .send(pdf);
    expect(put.status, show(put)).toBe(200);
    const evidenceDocumentId = evidence.documentId;
    // Any other live file of the entity (here the customer's bank slip) is refused with a code the workspace shows.
    const foreign = await t
      .http()
      .post(`/v1/sales-orders/${s.orderId}/schedule-lines/${s.scheduleLineIds[1]}/mark-billable`)
      .set('authorization', preparer)
      .set('idempotency-key', randomUUID())
      .send({
        evidenceDocumentId: s.proofDocumentId,
        expectedVersion: (await getOrder()).order.version,
      });
    expect(foreign.status, show(foreign)).toBe(422);
    expect(ErrorBodySchema.parse(foreign.body).error.code).toBe('invalid_evidence_document');
    const order = await getOrder();
    const marked = await t
      .http()
      .post(`/v1/sales-orders/${s.orderId}/schedule-lines/${s.scheduleLineIds[1]}/mark-billable`)
      .set('authorization', preparer)
      .set('idempotency-key', randomUUID())
      .send({ evidenceDocumentId, expectedVersion: order.order.version });
    expect(marked.status, show(marked)).toBe(201);

    const drafted = await t
      .http()
      .post('/v1/invoices/from-schedule')
      .set('authorization', preparer)
      .set('idempotency-key', randomUUID())
      .send({ scheduleLineId: s.scheduleLineIds[1] });
    expect(drafted.status, show(drafted)).toBe(201);
    const draft = InvoiceDetailSchema.parse(drafted.body).invoice;
    expect(draft.totals.total).toBe(SPLIT[1]);
    s.milestoneId = draft.id;

    await submitApproveIssue(s.milestoneId);
    expect((await settlementOf(s.milestoneId)).openAmount).toBe(SPLIT[1]);
  });

  it('11. a partial credit note on the milestone is drafted by finance2, approved accountant -> finance and issued', async () => {
    const milestone = await getInvoice(s.milestoneId);
    const line = milestone.lines[0]!;
    const half = new Decimal(line.quantity).div(2).toFixed(4, Decimal.ROUND_HALF_UP);

    const drafted = await t
      .http()
      .post('/v1/credit-notes')
      .set('authorization', await auth('finance2'))
      .set('idempotency-key', randomUUID())
      .send({
        originalInvoiceId: s.milestoneId,
        reason: 'Half of the milestone scope was descoped',
        lines: [{ originalLineNo: line.lineNo, quantity: half }],
      });
    expect(drafted.status, show(drafted)).toBe(201);
    const note = InvoiceDetailSchema.parse(drafted.body).invoice;
    expect(note).toMatchObject({
      kind: 'credit_note',
      status: 'draft',
      originalInvoiceId: s.milestoneId,
    });
    s.creditNoteId = note.id;

    const number = await submitApproveIssue(s.creditNoteId, 'finance2', NOTE_ROUTE);
    expect(number).toMatch(/^CN-\d{4}\/\d{2}-\d{5}$/);
    const issued = (await getInvoice(s.creditNoteId)).invoice;
    expect(issued.status).toBe('issued');
    // Partial: more than nothing, less than the milestone.
    const credit = new Decimal(issued.totals.total);
    expect(credit.gt(0)).toBe(true);
    expect(credit.lt(SPLIT[1]!)).toBe(true);

    // The credit is applied to the original, so the milestone's open amount falls by exactly the credit.
    const expectedOpen = new Decimal(SPLIT[1]!).minus(credit).toFixed(2);
    expect((await settlementOf(s.milestoneId)).openAmount).toBe(expectedOpen);
  });

  it('12. aging equals the open receivable total, and the audit chain verifies', async () => {
    const finance = await auth('finance');
    const credit = new Decimal((await getInvoice(s.creditNoteId)).invoice.totals.total);
    // Computed from the documents, not read back from the ledger: advance fully paid, milestone less the credit.
    const expectedOpen = new Decimal(SPLIT[1]!).minus(credit).toFixed(2);

    const open = await statement(true);
    const statementOpen = open
      .reduce((sum, r) => sum.plus(r.openAmount), new Decimal(0))
      .toFixed(2);
    expect(statementOpen).toBe(expectedOpen);
    expect(open.map((r) => r.invoiceId)).toEqual([s.milestoneId]);

    const res = await t.http().get('/v1/receivables/aging').set('authorization', finance);
    expect(res.status, show(res)).toBe(200);
    const aging = ArAgingReportSchema.parse(res.body);
    const row = aging.rows.find((r) => r.customerId === s.customerId && r.currency === 'NPR');
    expect(row, JSON.stringify(aging)).toBeDefined();
    expect(row!.totalOpen).toBe(expectedOpen);
    const bucketSum = Object.values(row!.buckets)
      .reduce((sum, b) => sum.plus(b), new Decimal(0))
      .toFixed(2);
    expect(bucketSum).toBe(expectedOpen);
    // This tenant has one customer, so the NPR total is the customer's row.
    const total = aging.totals.find((x) => x.currency === 'NPR');
    expect(total?.totalOpen).toBe(expectedOpen);

    const month = new Date().toISOString().slice(0, 7);
    const verify = await t
      .http()
      .get('/v1/audit/verify')
      .query({ month })
      .set('authorization', finance);
    expect(verify.status, show(verify)).toBe(200);
    const chain = ChainVerifyDtoSchema.parse(verify.body);
    expect(chain).toMatchObject({
      tenantId: world.isolated.tenantId,
      month,
      ok: true,
      firstBadSeq: null,
    });
    expect(chain.rows).toBeGreaterThan(0);
  });
});
