// BFF contract test: the workspace's REAL API clients (crm-api, verification-api, customers/api,
// quote-builder/api, quotations/api, lib/api-tax-codes) called against the REAL API over real HTTP.
//
// Why it exists: a UI-vs-API review found a builder that parsed the wrong response shape and dropped
// fields, and unit tests with hand-written mocks passed because the mocks matched the UI's assumption,
// not the API. Here the producer is the booted AppModule (Postgres as bos_app, Valkey, the real
// controllers and DTO mappers); the consumer code is untouched workspace code. Each call is checked twice:
//   1. the client's own zod schema accepted the real body (a mismatch would be an ApiError 502), and
//   2. no field the API sent was dropped by that schema (zod strips unknown keys, so a client schema that
//      lacks a field parses fine and the field silently disappears; only the raw body shows it).
// The request side is covered too: the API refuses a wrong path, method, body or missing Idempotency-Key.
//
// Run: pnpm --filter @bos/api test:e2e test/e2e/bff-contract.e2e.test.ts  (needs Docker, like every e2e).
//
// Not covered by a workspace client (so only the API's contract DTO is checked, from the raw body): GET
// version, submit (the client reads it as `unknown`), revise and the approvals action. Left out on purpose:
// the KYB decision (needs a clean scan, so the worker).
//
// P3 (the second describe, "quote to cash"): the clients of lib/api-billing.ts, lib/api-receivables.ts, the
// staff proof upload and the portal's api.billing.ts, over the same real API, with the data built the way
// p3-exit builds it (support/p3-fixtures.ts `seedP3World`, the worker for scans and PDF rendering, a fake
// Gotenberg). Reads: sales orders, invoices, payments, allocations, aging, statement, advance, and the
// portal's invoice list, detail, settlement, document link and payment list. Writes, each with its
// Idempotency-Key: confirm a sales order, mark a line billable, draft from schedule, draft a manual invoice,
// submit, discard, issue, credit note, debit note, staff proof upload and payment, verify, allocate, and the
// portal proof upload and payment submit. Not covered: reject, reverse and deallocate a payment.
// Shortcut, as in p3-exit: the portal login is seeded by SQL.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  ErrorBodySchema,
  InvoiceDetailSchema,
  PortalPaymentListItemSchema,
  QuotationDtoSchema,
  QuotationVersionDtoSchema,
  SalesOrderDetailSchema,
  SignedLinkDtoSchema,
  type AddressLines,
  type ApprovalRequestDto,
  type InvoiceDetail,
  type InvoiceSettlement,
  type PrintAddress,
  type QuotationVersionDto,
} from '@bos/contracts';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { InvoiceRenderSweeper } from '../../src/modules/invoices/render/invoice-render.sweeper';
import { QuotationRenderSweeper } from '../../src/modules/quotations/render/quotation-render.sweeper';
import { CLIENT_ID, startApp, type TestApp } from './support/app';
import {
  droppedKeys,
  loadBffClients,
  rowsOf,
  teeFetch,
  type BffClients,
  type BffSession,
  type FetchTee,
} from './support/bff-clients';
import { minimalPdf, pollUntil, seedPortalLogin, type PortalLogin } from './support/fixtures';
import { seedP3World, type P3PersonaKey, type P3World } from './support/p3-fixtures';
import { startWorker, type TestWorker } from './support/worker';

const e2e = inject('e2e');

// The entity's address prints with its country; a customer's address holds only the lines, its country is its own
// field (FX9).
const ENTITY_ADDRESS: PrintAddress = { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const CUSTOMER_ADDRESS: AddressLines = { line: '1 Durbar Marg', city: 'Kathmandu' };
const BUYER_EMAIL = 'buyer@contract-traders.test';

let t: TestApp;
let worker: TestWorker;
let clamd: FakeClamd;
let gotenberg: Server;
let world: P3World;
let filesRoot: string;
let bff: BffClients;
let tee: FetchTee;
let apiUrl = '';
const pdf = minimalPdf();

beforeAll(async () => {
  clamd = await startFakeClamd();
  // The invoice and quotation PDFs are rendered for real by the sweepers; Gotenberg answers a fixed PDF.
  gotenberg = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      res.end(pdf);
    });
  });
  await new Promise<void>((resolve) => gotenberg.listen(0, '127.0.0.1', resolve));
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-bff-contract-'));
  // The P2 steps and the P3 story share one tenant: the P3 world holds every P2 persona too.
  world = await seedP3World(e2e, 'e2e-bffc');

  // Read by AppModule when it is imported, so set before it boots (same set as the P3 exit e2e).
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-bff-contract.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-bff-contract-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: 'http://portal.e2e.test',
    GOTENBERG_URL: `http://127.0.0.1:${(gotenberg.address() as AddressInfo).port}`,
  });
  t = await startApp();
  // The scans (staff and portal proofs) and the render sweepers run in the worker, as in production.
  worker = await startWorker();
  // The workspace clients use `fetch`, so the API needs a real port (the other e2e files use supertest).
  await t.app.listen(0, '127.0.0.1');
  apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;

  tee = teeFetch(() => apiUrl);
  bff = await loadBffClients(() => apiUrl);
});

afterAll(async () => {
  tee?.restore();
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

/** The session the workspace holds for a persona: only the access token matters to `apiFetch`. */
async function session(key: P3PersonaKey): Promise<BffSession> {
  const persona = world.personas[key];
  return {
    accessToken: await t.token(world.isolated.staff, {
      userId: persona.sub,
      roles: persona.tokenRoles,
    }),
  };
}

interface SeenOptions {
  /** The call answers a list (bare array or `{ items }`): audit each row, and require at least one. */
  list?: boolean;
  /** A list that may legitimately be empty (a lookup the seed does not fill). */
  maybeEmpty?: boolean;
  /** Key paths this client drops on purpose, like `accounts`. */
  allowDropped?: readonly string[];
}

/**
 * One client call, and proof that the client kept everything the API sent. The raw body comes from the
 * very response the client parsed (the fetch tee), so a write is never repeated to look at it.
 */
async function seen<T>(fn: () => Promise<T>, options: SeenOptions = {}): Promise<T> {
  const { value, raw, exchange } = await tee.through(fn);
  const label = `${exchange.method} ${exchange.path}`;
  const sent = options.list === true ? rowsOf(raw) : raw;
  const kept = options.list === true ? rowsOf(value) : value;
  if (options.list === true && options.maybeEmpty !== true) {
    expect(Array.isArray(sent) && sent.length > 0, `${label} answered an empty list`).toBe(true);
  }
  expect(
    droppedKeys(sent, kept, options.allowDropped),
    `${label}: fields the API sent that the workspace client's schema drops`,
  ).toEqual([]);
  return value;
}

const show = (res: { status: number; body: unknown }): string =>
  `${res.status} ${JSON.stringify(res.body)}`;

/** Today in Kathmandu (valid_until and issue_date are Kathmandu dates), and `days` after it. */
const kathmanduDay = (shiftDays = 0): string => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
};

/** Authorization header of a persona, for the calls no workspace client makes. */
const bearer = async (key: P3PersonaKey): Promise<string> =>
  `Bearer ${(await session(key)).accessToken}`;

// Shared across the ordered steps below (one story, told step by step).
const s = {
  sales: undefined as BffSession | undefined,
  founder: undefined as BffSession | undefined,
  leadId: '',
  opportunityId: '',
  customerId: '',
  contactId: '',
  quotationId: '',
  versionId: '',
  caseId: '',
};
const sales = (): BffSession => s.sales!;
const founder = (): BffSession => s.founder!;

describe('BFF contract: workspace clients against the real API', () => {
  it('0. the founder sets the entity address, as production does before quoting', async () => {
    s.sales = await session('sales');
    s.founder = await session('founder');
    const res = await t
      .http()
      .put('/v1/admin/settings/entity.address')
      .set('authorization', await bearer('founder'))
      .send({ value: ENTITY_ADDRESS });
    expect([200, 204], show(res)).toContain(res.status);
  });

  it('1. leads: create, get, list, move through the stages, log an activity', async () => {
    const created = await seen(() =>
      bff.crm.createLead(
        sales(),
        {
          title: 'BFF contract lead',
          source: 'referral',
          currency: 'NPR',
          companyName: 'Contract Traders Pvt. Ltd.',
          contactName: 'Rina Shrestha',
          country: 'NP',
          email: BUYER_EMAIL,
          phones: [],
        },
        randomUUID(),
      ),
    );
    expect(created).toMatchObject({ title: 'BFF contract lead', stage: 'new' });
    s.leadId = created.id;

    const got = await seen(() => bff.crm.getLead(sales(), s.leadId));
    expect(got.id).toBe(s.leadId);

    const listed = await seen(() => bff.crm.listLeads(sales(), { limit: 50 }), { list: true });
    expect(listed.map((l) => l.id)).toContain(s.leadId);

    let lead = got;
    for (const stage of ['contacted', 'qualified'] as const) {
      lead = await seen(() =>
        bff.crm.changeLeadStage(sales(), s.leadId, {
          stage,
          expectedVersion: lead.version,
          // Moving to Contacted needs the call, email or meeting that made the contact (D48).
          ...(stage === 'contacted'
            ? { contactActivity: { kind: 'call', body: 'Intro call' } }
            : {}),
        }),
      );
      expect(lead.stage).toBe(stage);
    }

    const note = await seen(() =>
      bff.crm.createActivity(
        sales(),
        { kind: 'note', subject: 'Called the buyer', leadId: s.leadId },
        randomUUID(),
      ),
    );
    expect(note).toMatchObject({ kind: 'note', subject: 'Called the buyer' });
    const activities = await seen(() => bff.crm.listActivities(sales(), { leadId: s.leadId }), {
      list: true,
    });
    expect(activities.map((a) => a.id)).toContain(note.id);
  });

  it('2. convert answers { opportunityId, customerId } and the opportunity reads back', async () => {
    const lead = await seen(() => bff.crm.getLead(sales(), s.leadId));
    const converted = await seen(() =>
      bff.crm.convertLead(
        sales(),
        s.leadId,
        {
          customer: {
            mode: 'create',
            customer: {
              legalName: 'Contract Traders Pvt. Ltd.',
              relationship: 'prospect',
              country: 'NP',
              address: CUSTOMER_ADDRESS,
            },
          },
          contact: {
            mode: 'create',
            contact: {
              fullName: 'Rina Shrestha',
              email: BUYER_EMAIL,
              country: 'NP',
              phones: [],
              isPrimary: true,
            },
          },
          opportunityName: 'Contract Traders website',
          expectedVersion: lead.version,
        },
        randomUUID(),
      ),
    );
    expect(converted.customerId, 'convert should name the customer it created').toBeDefined();
    s.opportunityId = converted.opportunityId;
    s.customerId = converted.customerId!;

    const opportunity = await seen(() => bff.crm.getOpportunity(sales(), s.opportunityId));
    expect(opportunity).toMatchObject({ id: s.opportunityId, stage: 'qualified' });
    const listed = await seen(() => bff.crm.listOpportunities(sales(), { limit: 50 }), {
      list: true,
    });
    expect(listed.map((o) => o.id)).toContain(s.opportunityId);

    const note = await seen(() =>
      bff.crm.createActivity(
        sales(),
        { kind: 'call', subject: 'Scoping call', opportunityId: s.opportunityId },
        randomUUID(),
      ),
    );
    const activities = await seen(
      () => bff.crm.listActivities(sales(), { opportunityId: s.opportunityId }),
      { list: true },
    );
    expect(activities.map((a) => a.id)).toContain(note.id);
  });

  it('3. customers: list, get, get with terms, contacts (CRM client and builder client)', async () => {
    const listing = await seen(
      () => bff.customers.listCustomers(sales(), { q: 'Contract Traders', limit: 25 }),
      { list: true },
    );
    expect(listing.items.map((c) => c.id)).toContain(s.customerId);

    // `getCustomer` is the contract's CustomerDto, which has none of the detail-only fields: dropping them is by
    // design, `getCustomerDetail` (CustomerDetailSchema) is the reader that keeps them. Beside `accounts`, later rounds
    // added `people` (account owner names), `can` (record capabilities, D50), `verification` (case presence) and
    // `portalAccess` (F1-Q31), all read through the detail reader below. Stale before: only `accounts` was allowed.
    const detailOnly = [
      'accounts',
      'actingEntity',
      'people',
      'can',
      'verification',
      'portalAccess',
    ];
    const customer = await seen(() => bff.customers.getCustomer(sales(), s.customerId), {
      allowDropped: detailOnly,
    });
    expect(customer.id).toBe(s.customerId);
    // The reader that keeps them must drop none of them.
    const detail = await seen(() => bff.customers.getCustomerDetail(sales(), s.customerId));
    expect(detail.accounts, 'staff get the per-entity terms with the customer').toBeDefined();
    expect(detail.can, 'the record capabilities reach the page').toBeDefined();
    expect(detail.portalAccess, 'portal access reaches the page').toBeDefined();

    const contacts = await seen(() => bff.customers.listContacts(sales(), s.customerId), {
      list: true,
    });
    expect(contacts.items).toHaveLength(1);
    s.contactId = contacts.items[0]!.id;

    // The quote builder reads the same records through its own client and its own list parsing.
    const builderOpportunity = await seen(() =>
      bff.builder.getOpportunity(sales(), s.opportunityId),
    );
    expect(builderOpportunity.id).toBe(s.opportunityId);
    const builderCustomer = await seen(() => bff.builder.getCustomer(sales(), s.customerId), {
      allowDropped: detailOnly,
    });
    expect(builderCustomer.id).toBe(s.customerId);
    const builderContacts = await seen(() => bff.builder.listContacts(sales(), s.customerId), {
      list: true,
    });
    expect(builderContacts.map((c) => c.id)).toEqual([s.contactId]);
  });

  it('4. quotation lookups: tax codes (with the seeded VAT13) and payment terms', async () => {
    const codes = await seen(() => bff.taxCodes.listTaxCodes(sales()), { list: true });
    expect(codes.map((c) => c.code)).toContain('VAT13');
    // The production seed may not fill payment terms; the shape is still audited when it does.
    await seen(() => bff.builder.listPaymentTerms(sales()), { list: true, maybeEmpty: true });
  });

  it('5. quotation: create, list, detail, preview, save a draft, submit', async () => {
    const codes = await bff.taxCodes.listTaxCodes(sales());
    const vat13 = codes.find((c) => c.code === 'VAT13');
    expect(vat13, 'the production seed gives the tenant VAT13').toBeDefined();
    const lines = [
      {
        description: 'Website build',
        uom: 'lot',
        quantity: '1',
        unitPrice: '10000.00',
        taxCodeId: vat13!.id,
      },
    ];

    const quotation = await seen(() =>
      bff.builder.createQuotation(
        sales(),
        {
          opportunityId: s.opportunityId,
          contactId: s.contactId,
          currency: 'NPR',
          issueDate: kathmanduDay(),
          validUntil: kathmanduDay(30),
          lines,
        },
        randomUUID(),
      ),
    );
    expect(quotation.customerId).toBe(s.customerId);
    s.quotationId = quotation.id;
    s.versionId = quotation.currentVersionId;

    const listed = await seen(() => bff.quotations.listQuotations(sales()), { list: true });
    expect(listed.map((q) => q.id)).toContain(s.quotationId);

    const detail = await seen(() => bff.quotations.getQuotation(sales(), s.quotationId));
    expect(detail.versions.map((v) => v.id)).toEqual([s.versionId]);

    // No workspace client reads one version, so the API's own contract DTO is the check.
    const version = await getVersion();
    expect(version.status).toBe('draft');

    const preview = await seen(() =>
      bff.builder.previewVersion(sales(), s.quotationId, s.versionId, {
        currency: 'NPR',
        lines,
      }),
    );
    expect(preview.route.blocked).toBe(false);

    // The save answers `{ version }` only on purpose (SavedVersionSchema is partial), so no key audit.
    const saved = await bff.builder.updateDraft(sales(), s.quotationId, s.versionId, {
      expectedVersion: version.version,
      scope: 'Contract test scope',
    });
    expect(saved.version).toBeGreaterThan(version.version);
    expect((await getVersion()).scope).toBe('Contract test scope');

    // `submitVersion` reads the answer as `unknown`; the contract DTO is checked from the raw body.
    const { raw } = await tee.through(() =>
      bff.builder.submitVersion(sales(), s.quotationId, s.versionId, saved.version, randomUUID()),
    );
    const submitted = QuotationVersionDtoSchema.parse(raw);
    expect(submitted.status).toBe('submitted');
    expect(submitted.approvalRequestId).not.toBeNull();
  });

  it('6. after a reject the detail and list read back, and revise answers a draft version', async () => {
    const requestId = (await getVersion()).approvalRequestId!;
    const accountant = await bearer('accountant');
    const request = await t
      .http()
      .get(`/v1/approvals/requests/${requestId}`)
      .set('authorization', accountant);
    expect(request.status, show(request)).toBe(200);
    const open: ApprovalRequestDto = ApprovalRequestDtoSchema.parse(request.body);

    const rejected = await t
      .http()
      .post(`/v1/approvals/requests/${requestId}/actions`)
      .set('authorization', accountant)
      .set('idempotency-key', randomUUID())
      .send({
        action: 'reject',
        comment: 'Contract test: send back for revision',
        expectedVersion: open.version,
      });
    expect(rejected.status, show(rejected)).toBe(200);

    const afterReject = await getVersion();
    expect(afterReject.status).toBe('rejected');

    const revised = await t
      .http()
      .post(`/v1/quotations/${s.quotationId}/revise`)
      .set('authorization', await bearer('sales'))
      .set('idempotency-key', randomUUID())
      .send({ reason: 'Contract test revision', expectedVersion: afterReject.version });
    expect(revised.status, show(revised)).toBe(201);
    const draft = QuotationVersionDtoSchema.parse(revised.body);
    expect(draft.status).toBe('draft');
    expect(draft.id).not.toBe(s.versionId);

    // The screens read the quotation again after a revise: two versions, the new one current.
    const detail = await seen(() => bff.quotations.getQuotation(sales(), s.quotationId));
    expect(detail.versions.map((v) => v.id)).toEqual(
      expect.arrayContaining([s.versionId, draft.id]),
    );
    const listed = await seen(() => bff.quotations.listQuotations(sales(), { status: 'draft' }), {
      list: true,
      maybeEmpty: true,
    });
    expect(Array.isArray(listed)).toBe(true);
  });

  it('7. KYB: open a case, attach the required documents, read the document, submit', async () => {
    const opened = await seen(() =>
      bff.verification.openVerificationCase(founder(), s.customerId, randomUUID()),
    );
    expect(opened).toMatchObject({ partyId: s.customerId, status: 'draft' });
    s.caseId = opened.id;

    const got = await seen(() => bff.customers.getVerificationCase(founder(), s.caseId));
    expect(got.id).toBe(s.caseId);
    const byParty = await seen(
      () => bff.customers.listVerificationCases(founder(), { partyId: s.customerId }),
      { list: true },
    );
    expect(byParty.items.map((c) => c.id)).toContain(s.caseId);
    const byStatus = await seen(
      () => bff.customers.listVerificationCases(founder(), { status: 'draft' }),
      { list: true },
    );
    expect(byStatus.items.map((c) => c.id)).toContain(s.caseId);

    const authz = await bearer('founder');
    const required = got.checklist.filter((i) => i.required).map((i) => i.key);
    expect(required.length, 'a new case starts with required checklist items').toBeGreaterThan(0);

    let current = got;
    let lastDocumentId = '';
    for (const key of required) {
      const pdf = minimalPdf();
      const created = await t
        .http()
        .post('/v1/documents')
        .set('authorization', authz)
        .send({
          ownerType: 'verification_case',
          ownerId: s.caseId,
          filename: `${key}.pdf`,
          declaredMime: 'application/pdf',
          sizeBytes: pdf.length,
        });
      expect(created.status, show(created)).toBe(201);
      const { documentId, uploadPath } = created.body as { documentId: string; uploadPath: string };
      const put = await t
        .http()
        .put(uploadPath)
        .set('authorization', authz)
        .set('content-type', 'application/pdf')
        .send(pdf);
      expect(put.status, show(put)).toBe(200);

      current = await seen(() =>
        bff.verification.attachChecklistDocument(
          founder(),
          s.caseId,
          { key, documentId, expectedVersion: current.version },
          randomUUID(),
        ),
      );
      expect(current.checklist.find((i) => i.key === key)?.documentId).toBe(documentId);
      lastDocumentId = documentId;
    }

    // `DocumentSchema` reads only what the case page needs on purpose, so no key audit here.
    const document = await bff.verification.getDocument(founder(), lastDocumentId);
    expect(document.id).toBe(lastDocumentId);
    expect(document.versions).toHaveLength(1);

    const submitted = await seen(() =>
      bff.verification.submitVerificationCase(founder(), s.caseId, randomUUID(), current.version),
    );
    expect(submitted.status).toBe('submitted');
  });

  it('8. an API refusal reaches the workspace as an ApiError whose body is the contract error envelope', async () => {
    const error = await bff.crm.getLead(sales(), randomUUID()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(bff.ApiError);
    const failure = error as InstanceType<typeof bff.ApiError>;
    expect(failure.status).toBe(404);
    expect(ErrorBodySchema.safeParse(failure.body).success, JSON.stringify(failure.body)).toBe(
      true,
    );
  });

  it('9. the last step of the story: the opportunity stage change answers the updated opportunity', async () => {
    const opportunity = await bff.crm.getOpportunity(sales(), s.opportunityId);
    const moved = await seen(() =>
      bff.crm.changeOpportunityStage(sales(), s.opportunityId, {
        stage: 'requirement_received',
        expectedVersion: opportunity.version,
      }),
    );
    expect(moved.stage).toBe('requirement_received');
  });
});

// A real GET of the current version; no workspace client reads one version (the contract DTO is the check).
async function getVersion(): Promise<QuotationVersionDto> {
  const res = await t
    .http()
    .get(`/v1/quotations/${s.quotationId}/versions/${s.versionId}`)
    .set('authorization', await bearer('sales'));
  expect(res.status, show(res)).toBe(200);
  return QuotationVersionDtoSchema.parse(res.body);
}

// ============================================================================================== P3
// The same producer (the booted API), the P3 consumers: lib/api-billing.ts, lib/api-receivables.ts, the staff
// proof upload and the portal's api.billing.ts. The cast follows p3-exit (separation of duties): `preparer`
// (accountant role) confirms, drafts, submits and records the staff payment; `accountant` and `finance`
// approve; `finance` issues; `finance2` drafts the credit note, verifies both payments and allocates them.

// Done check 1's golden order, as in p3-exit: 4,465,000.00 + VAT 13% = 5,045,450.00, advance 60% = 3,027,270.00.
const LINE_PRICE = '4465000.00';
const ADVANCE_TOTAL = '3027270.00';
const STAFF_PAID = '3100000.00';
const STAFF_EXCESS = '72730.00';
// A manual invoice of one line: 10,000.00 + VAT 13% = 11,300.00. The customer pays 5,000.00 of it.
const MANUAL_PRICE = '10000.00';
const MANUAL_TOTAL = '11300.00';
const PORTAL_PAID = '5000.00';

const key = (): string => randomUUID();

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const p3 = {
  login: undefined as PortalLogin | undefined,
  customerId: '',
  contactId: '',
  opportunityId: '',
  quotationId: '',
  versionId: '',
  vat13Id: '',
  orderId: '',
  scheduleLineIds: [] as string[],
  advanceId: '',
  manualId: '',
  discardedId: '',
  creditNoteId: '',
  debitNoteId: '',
  staffPaymentId: '',
  portalPaymentId: '',
};

/** The portal user's session: the customer's token, minted against the customer's own IdP org. */
async function portalSession(): Promise<BffSession> {
  const login = p3.login!;
  return {
    accessToken: await t.token(
      { zitadelOrgId: login.zitadelOrgId },
      { userId: login.sub, roles: ['customer_user'] },
    ),
  };
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The approver persona of each role a route can name. The preparer is never one: they drafted. */
const APPROVER_OF: Partial<Record<string, P3PersonaKey>> = {
  accountant: 'accountant',
  finance: 'finance',
  management: 'management',
  founder: 'founder',
};

/**
 * Walks an approval request to `approved`, one step at a time, each by the persona of the step's role. The founder
 * step needs a fresh ID token (step-up); it is attached only there. Copied from p3-exit.
 */
async function approveAll(requestId: string): Promise<string[]> {
  const reader = await bearer('founder');
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
    const approver = step?.roleKey == null ? undefined : APPROVER_OF[step.roleKey];
    expect(approver, `no approver persona for step ${JSON.stringify(step)}`).toBeDefined();
    const headers: Record<string, string> = {};
    if (approver === 'founder') {
      headers['x-bos-id-token'] = await t.issuer.mintIdToken({
        sub: world.personas.founder.sub,
        authTime: nowSeconds() - 10,
        audience: CLIENT_ID,
      });
    }
    const res = await t
      .http()
      .post(`/v1/approvals/requests/${requestId}/actions`)
      .set('authorization', await bearer(approver!))
      .set('idempotency-key', randomUUID())
      .set(headers)
      .send({ action: 'approve', expectedVersion: request.version });
    expect(res.status, `${approver} approving: ${show(res)}`).toBe(200);
    decided.push(step!.roleKey!);
  }
  throw new Error(`approval request ${requestId} did not reach approved`);
}

/**
 * Submit, approve and issue a draft invoice, every staff call through the workspace client with its own
 * Idempotency-Key. `submitInvoice` answers `unknown` to the client, so its raw body is parsed with the contract.
 */
async function submitApproveIssue(
  invoiceId: string,
  submitter: P3PersonaKey = 'preparer',
): Promise<string> {
  const author = await session(submitter);
  const draft = await seen(() => bff.billing.getInvoice(author, invoiceId));
  const { raw } = await tee.through(() =>
    bff.billing.submitInvoice(author, invoiceId, { expectedVersion: draft.invoice.version }, key()),
  );
  const submitted = InvoiceDetailSchema.parse(raw).invoice;
  expect(submitted.status).toBe('submitted');
  expect(submitted.approvalRequestId).not.toBeNull();

  await approveAll(submitted.approvalRequestId!);
  const finance = await session('finance');
  const approved = await seen(() => bff.billing.getInvoice(finance, invoiceId));
  expect(approved.invoice.status).toBe('approved');

  const issued = await seen(() =>
    bff.billing.issueInvoice(
      finance,
      invoiceId,
      { expectedVersion: approved.invoice.version },
      key(),
    ),
  );
  expect(issued).toMatchObject({ kind: 'issued', invoiceId });
  return issued.number;
}

/** Waits for the worker's scan to mark every version of a document clean (a payment names only clean proofs). */
async function untilClean(what: string, documentId: string): Promise<void> {
  await pollUntil(
    what,
    async () => {
      const { rows } = await world.pool.query<{ status: string }>(
        'SELECT status FROM app.document_versions WHERE document_id = $1',
        [documentId],
      );
      const statuses = rows.map((r) => r.status);
      if (statuses.some((x) => x === 'infected' || x === 'scan_failed')) {
        throw new Error(`the ${what} scan ended ${statuses.join(',')}`);
      }
      const clean = statuses.length > 0 && statuses.every((x) => x === 'clean');
      return { done: clean ? true : undefined, last: statuses };
    },
    60_000,
    300,
  );
}

async function openInvoice(id: string, as: P3PersonaKey = 'finance'): Promise<InvoiceDetail> {
  return seen(async () => bff.billing.getInvoice(await session(as), id));
}

describe('BFF contract P3: billing, receivables and portal clients against the real API', () => {
  it('10. setup: a customer, a quotation accepted in the portal (built as p3-exit builds it)', async () => {
    const salesAuth = await bearer('sales');
    const created = await t.http().post('/v1/leads').set('authorization', salesAuth).send({
      title: 'Store platform for Contract Retail',
      source: 'referral',
      companyName: 'Contract Retail Pvt. Ltd.',
      contactName: 'Hari Gurung',
      country: 'NP',
      email: 'hari@contract-retail.test',
    });
    expect(created.status, show(created)).toBe(201);
    const lead = created.body as { id: string; version: number };
    let version = lead.version;
    for (const stage of ['contacted', 'qualified'] as const) {
      const moved = await t
        .http()
        .patch(`/v1/leads/${lead.id}/stage`)
        .set('authorization', salesAuth)
        .send({
          stage,
          expectedVersion: version,
          ...(stage === 'contacted'
            ? { contactActivity: { kind: 'call', body: 'Intro call' } }
            : {}),
        });
      expect(moved.status, show(moved)).toBe(200);
      version = (moved.body as { version: number }).version;
    }
    const converted = await t
      .http()
      .post(`/v1/leads/${lead.id}/convert`)
      .set('authorization', salesAuth)
      .set('idempotency-key', randomUUID())
      .send({
        customer: {
          mode: 'create',
          customer: {
            legalName: 'Contract Retail Pvt. Ltd.',
            country: 'NP',
            address: CUSTOMER_ADDRESS,
          },
        },
        contact: {
          mode: 'create',
          contact: { fullName: 'Hari Gurung', email: 'hari@contract-retail.test', country: 'NP' },
        },
        opportunityName: 'Contract Retail store platform',
        expectedVersion: version,
      });
    expect(converted.status, show(converted)).toBe(201);
    const ids = converted.body as { opportunityId: string; customerId: string };
    p3.opportunityId = ids.opportunityId;
    p3.customerId = ids.customerId;
    const contacts = await t
      .http()
      .get(`/v1/customers/${p3.customerId}/contacts`)
      .set('authorization', salesAuth);
    expect(contacts.status, show(contacts)).toBe(200);
    p3.contactId = (contacts.body as { id: string }[])[0]!.id;

    const codes = await bff.taxCodes.listTaxCodes(await session('sales'));
    const vat13 = codes.find((c) => c.code === 'VAT13');
    expect(vat13, 'the production seed gives the tenant VAT13').toBeDefined();
    p3.vat13Id = vat13!.id;

    // No paymentSchedule: plan A7's default 60/20/20 (advance, milestone, UAT) applies.
    const quote = await t
      .http()
      .post('/v1/quotations')
      .set('authorization', salesAuth)
      .set('idempotency-key', randomUUID())
      .send({
        opportunityId: p3.opportunityId,
        contactId: p3.contactId,
        currency: 'NPR',
        issueDate: kathmanduDay(),
        validUntil: kathmanduDay(30),
        lines: [
          {
            description: 'Store platform build',
            uom: 'lot',
            quantity: '1',
            unitPrice: LINE_PRICE,
            taxCodeId: p3.vat13Id,
          },
        ],
      });
    expect(quote.status, show(quote)).toBe(201);
    const q = QuotationDtoSchema.parse(quote.body);
    p3.quotationId = q.id;
    p3.versionId = q.currentVersionId;

    const versionPath = `/v1/quotations/${p3.quotationId}/versions/${p3.versionId}`;
    const readVersion = async (): Promise<QuotationVersionDto> => {
      const res = await t.http().get(versionPath).set('authorization', salesAuth);
      expect(res.status, show(res)).toBe(200);
      return QuotationVersionDtoSchema.parse(res.body);
    };
    const submitted = await t
      .http()
      .post(`${versionPath}/submit`)
      .set('authorization', salesAuth)
      .set('idempotency-key', randomUUID())
      .send({ expectedVersion: (await readVersion()).version });
    expect(submitted.status, show(submitted)).toBe(200);
    await approveAll(QuotationVersionDtoSchema.parse(submitted.body).approvalRequestId!);
    expect((await readVersion()).status).toBe('approved');

    const swept = await worker.app.get(QuotationRenderSweeper).sweep();
    expect(swept.failures, JSON.stringify(swept)).toEqual([]);
    await pollUntil(
      'the quotation PDF to scan clean',
      async () => {
        const v = await readVersion();
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
      .set('authorization', salesAuth)
      .set('idempotency-key', randomUUID())
      .send({ recipientContactId: p3.contactId, expectedVersion: (await readVersion()).version });
    expect(sent.status, show(sent)).toBe(200);

    // SHORTCUT (as p2-exit and p3-exit): the portal login is seeded by SQL.
    p3.login = await seedPortalLogin(e2e, world.scope, p3.customerId);
    const accepted = await t
      .http()
      .post(`/v1/portal/quotations/${p3.versionId}/accept`)
      .set('authorization', `Bearer ${(await portalSession()).accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ acceptedByName: 'Hari Gurung', confirm: true });
    expect(accepted.status, show(accepted)).toBe(201);
    expect((await readVersion()).status).toBe('accepted');
  }, 150_000);

  it('11. sales orders: confirm through the client, then list (with filters) and detail', async () => {
    // F1-Q28: Sales confirm the portal acceptance's evidence before the order is confirmed (raw HTTP: the workspace
    // client has no call for it yet).
    const evidence = await t
      .http()
      .post(`/v1/quotations/${p3.quotationId}/versions/${p3.versionId}/evidence-confirmation`)
      .set('authorization', await bearer('sales'))
      .set('idempotency-key', randomUUID())
      .send({ evidenceKinds: ['signed_quote'] });
    expect(evidence.status, show(evidence)).toBe(201);
    const preparer = await session('preparer');
    const confirmed = await seen(() =>
      bff.billing.confirmSalesOrder(
        preparer,
        { quotationVersionId: p3.versionId, evidenceDocumentIds: [] },
        key(),
      ),
    );
    expect(confirmed.order).toMatchObject({ status: 'confirmed', customerId: p3.customerId });
    p3.orderId = confirmed.order.id;
    const schedule = [...confirmed.schedule].sort((a, b) => a.seq - b.seq);
    expect(schedule.map((l) => l.trigger)).toEqual(['advance', 'milestone', 'uat']);
    p3.scheduleLineIds = schedule.map((l) => l.id);

    const all = await seen(() => bff.billing.listSalesOrders(preparer), { list: true });
    expect(all.map((o) => o.id)).toContain(p3.orderId);
    const filtered = await seen(
      () =>
        bff.billing.listSalesOrders(preparer, { status: 'confirmed', customerId: p3.customerId }),
      { list: true },
    );
    expect(filtered.map((o) => o.id)).toEqual([p3.orderId]);

    const detail = await seen(() => bff.billing.getSalesOrder(preparer, p3.orderId));
    expect(detail.order.id).toBe(p3.orderId);
    expect(detail.schedule).toHaveLength(3);
  });

  it('12. the advance: mark billable and draft from the schedule through the client, then submit, approve, issue', async () => {
    const preparer = await session('preparer');
    const order = await seen(() => bff.billing.getSalesOrder(preparer, p3.orderId));
    const advance = order.schedule.find((l) => l.id === p3.scheduleLineIds[0])!;
    if (advance.status === 'planned') {
      // `markScheduleLineBillable` answers `unknown` to the client: the raw body is the order detail.
      const { raw } = await tee.through(() =>
        bff.billing.markScheduleLineBillable(
          preparer,
          p3.orderId,
          advance.id,
          { expectedVersion: order.order.version },
          key(),
        ),
      );
      expect(SalesOrderDetailSchema.parse(raw).order.id).toBe(p3.orderId);
    }

    const draft = await seen(() =>
      bff.billing.draftInvoiceFromSchedule(preparer, { scheduleLineId: advance.id }, key()),
    );
    expect(draft.invoice).toMatchObject({ kind: 'tax_invoice', status: 'draft', number: null });
    expect(draft.invoice.totals.total).toBe(ADVANCE_TOTAL);
    p3.advanceId = draft.invoice.id;

    const number = await submitApproveIssue(p3.advanceId);
    expect(number).toMatch(/^INV-/);
  });

  it('13. the advance invoice reads: list (with filters), detail, and the document link once the PDF is clean', async () => {
    const finance = await session('finance');
    const all = await seen(() => bff.billing.listInvoices(finance), { list: true });
    expect(all.map((i) => i.id)).toContain(p3.advanceId);
    const filtered = await seen(
      () =>
        bff.billing.listInvoices(finance, {
          kind: 'tax_invoice',
          status: 'issued',
          customerId: p3.customerId,
        }),
      { list: true },
    );
    expect(filtered.map((i) => i.id)).toEqual([p3.advanceId]);
    expect((await openInvoice(p3.advanceId)).invoice).toMatchObject({ status: 'issued' });

    // Until the scan is clean the document route answers 409 invoice_pdf_not_ready (still being prepared), or 404 before
    // any document exists (no unscanned file is ever linked): wait for it. The issue itself now enqueues the render.
    // Other files leave issued invoices in this shared test DB; the global sweep takes only 10.
    const rendered = await worker.app.get(InvoiceRenderSweeper).renderOne({
      ...world.scope,
      invoiceId: p3.advanceId,
    });
    expect(['rendered', 'skipped']).toContain(rendered);
    const path = bff.billing.invoiceDocumentPath(p3.advanceId);
    const link = await pollUntil(
      'the advance invoice PDF to scan clean',
      async () => {
        const res = await t
          .http()
          .get(path)
          .set('authorization', await bearer('finance'));
        const waiting =
          res.status === 404 ||
          (res.status === 409 &&
            (res.body as { error?: { code?: string } } | undefined)?.error?.code ===
              'invoice_pdf_not_ready');
        if (res.status !== 200 && !waiting) throw new Error(show(res));
        return {
          done: res.status === 200 ? SignedLinkDtoSchema.parse(res.body) : undefined,
          last: show(res),
        };
      },
      60_000,
      500,
    );
    expect(link.url).toBeTruthy();
  }, 90_000);

  it('14. the portal reads the issued advance: list, detail, settlement and document link', async () => {
    const customer = await portalSession();
    const list = await seen(() => bff.portalBilling.listPortalInvoices(customer), { list: true });
    expect(list.map((i) => i.id)).toEqual([p3.advanceId]);

    const view = await seen(() => bff.portalBilling.getPortalInvoice(customer, p3.advanceId));
    expect(view.totals.total).toBe(ADVANCE_TOTAL);

    // The portal reads only some settlement fields on purpose (`PortalSettlementSchema` is a `.pick()`).
    const settlement = await seen(
      () => bff.portalBilling.getPortalInvoiceSettlement(customer, p3.advanceId),
      { allowDropped: ['number', 'kind', 'customerId', 'issueDate', 'allocatedAmount'] },
    );
    expect(settlement).toMatchObject({ invoiceId: p3.advanceId, openAmount: ADVANCE_TOTAL });

    const link = await seen(() => bff.portalBilling.getPortalInvoiceLink(customer, p3.advanceId));
    expect(link.url).toBeTruthy();

    // No payment yet: the list may be empty, and each row is still audited when it is not.
    await seen(() => bff.portalBilling.listPortalPayments(customer), {
      list: true,
      maybeEmpty: true,
    });
  });

  it('15. a manual invoice: draft through the client, a second draft discarded, the first submitted and issued', async () => {
    const preparer = await session('preparer');
    const manual = await seen(() =>
      bff.billing.createManualInvoice(
        preparer,
        {
          customerId: p3.customerId,
          currency: 'NPR',
          manualReason: 'Contract test: a hosting add-on outside the order',
          lines: [
            {
              description: 'Hosting add-on',
              uom: 'lot',
              quantity: '1',
              unitPrice: MANUAL_PRICE,
              taxCodeId: p3.vat13Id,
            },
          ],
        },
        key(),
      ),
    );
    expect(manual.invoice).toMatchObject({ kind: 'tax_invoice', status: 'draft' });
    expect(manual.invoice.totals.total).toBe(MANUAL_TOTAL);
    p3.manualId = manual.invoice.id;

    const second = await seen(() =>
      bff.billing.createManualInvoice(
        preparer,
        {
          customerId: p3.customerId,
          currency: 'NPR',
          manualReason: 'Contract test: a draft that is thrown away',
          lines: [
            {
              description: 'Entered twice',
              uom: 'lot',
              quantity: '1',
              unitPrice: '1.00',
              taxCodeId: p3.vat13Id,
            },
          ],
        },
        key(),
      ),
    );
    p3.discardedId = second.invoice.id;
    // `discardInvoice` answers `unknown`: success is a 2xx, and the invoice then reads back as discarded.
    const { exchange } = await tee.through(() =>
      bff.billing.discardInvoice(
        preparer,
        p3.discardedId,
        { expectedVersion: second.invoice.version, reason: 'Contract test: entered twice' },
        key(),
      ),
    );
    expect(exchange.status).toBeGreaterThanOrEqual(200);
    expect(exchange.status).toBeLessThan(300);
    expect((await openInvoice(p3.discardedId, 'preparer')).invoice.status).toBe('discarded');
    const discarded = await seen(
      () => bff.billing.listInvoices(preparer, { status: 'discarded', customerId: p3.customerId }),
      { list: true },
    );
    expect(discarded.map((i) => i.id)).toEqual([p3.discardedId]);

    expect(await submitApproveIssue(p3.manualId)).toMatch(/^INV-/);
  });

  it('16. a staff payment: upload the bank slip, record it, verify (a different user) and allocate with an excess', async () => {
    const preparer = await session('preparer');
    const documentId = await bff.staffProofs.uploadStaffPaymentProof(preparer, {
      customerId: p3.customerId,
      filename: 'bank-slip.pdf',
      mime: 'application/pdf',
      size: pdf.length,
      body: streamOf(pdf),
    });
    await untilClean('the staff bank slip', documentId);

    const payment = await seen(() =>
      bff.receivables.submitPayment(
        preparer,
        {
          customerId: p3.customerId,
          currency: 'NPR',
          amount: STAFF_PAID,
          tdsWithheld: '0.00',
          method: 'bank_transfer',
          receivedOn: kathmanduDay(),
          bankReference: 'NABIL-CONTRACT-1',
          proofDocumentIds: [documentId],
        },
        key(),
      ),
    );
    expect(payment).toMatchObject({ status: 'submitted', amount: STAFF_PAID });
    p3.staffPaymentId = payment.id;

    const listed = await seen(() => bff.receivables.listPayments(preparer), { list: true });
    expect(listed.map((x) => x.id)).toContain(p3.staffPaymentId);
    const submittedOnly = await seen(() => bff.receivables.listPayments(preparer, 'submitted'), {
      list: true,
    });
    expect(submittedOnly.map((x) => x.id)).toContain(p3.staffPaymentId);
    const got = await seen(() => bff.receivables.getPayment(preparer, p3.staffPaymentId));
    expect(got.id).toBe(p3.staffPaymentId);

    // The recorder cannot verify their own payment: `finance2` is a different Finance user.
    const finance2 = await session('finance2');
    const verified = await seen(() =>
      bff.receivables.verifyPayment(
        finance2,
        p3.staffPaymentId,
        { expectedVersion: got.version },
        key(),
      ),
    );
    expect(verified.status).toBe('verified');
    expect(verified.number).toMatch(/^RCPT-/);

    const allocated = await seen(
      () =>
        bff.receivables.allocatePayment(
          finance2,
          p3.staffPaymentId,
          { lines: [{ invoiceId: p3.advanceId, amount: ADVANCE_TOTAL }] },
          key(),
        ),
      { list: true },
    );
    expect(allocated.map((r) => [r.invoiceId, r.paymentId, r.amount])).toEqual([
      [p3.advanceId, p3.staffPaymentId, ADVANCE_TOTAL],
    ]);
    const rows = await seen(
      () => bff.receivables.listPaymentAllocations(finance2, p3.staffPaymentId),
      { list: true },
    );
    expect(rows.map((r) => r.id)).toEqual(allocated.map((r) => r.id));
  }, 90_000);

  it('17. a portal payment: upload the proof and submit through the portal client, then Finance verifies and allocates it', async () => {
    const customer = await portalSession();
    const documentId = await bff.portalBilling.uploadPaymentProof(customer, {
      filename: 'portal-slip.pdf',
      mime: 'application/pdf',
      size: pdf.length,
      body: streamOf(pdf),
    });
    await untilClean('the portal bank slip', documentId);

    // `submitPortalPayment` reads no body (it answers void): the raw answer is the list row of the payment.
    const { raw } = await tee.through(() =>
      bff.portalBilling.submitPortalPayment(
        customer,
        {
          currency: 'NPR',
          amount: PORTAL_PAID,
          tdsWithheld: '0.00',
          method: 'bank_transfer',
          receivedOn: kathmanduDay(),
          bankReference: 'NABIL-CONTRACT-2',
          proofDocumentIds: [documentId],
        },
        key(),
      ),
    );
    const item = PortalPaymentListItemSchema.parse(raw);
    expect(item).toMatchObject({ status: 'submitted', amount: PORTAL_PAID, number: null });
    p3.portalPaymentId = item.id;

    const mine = await seen(() => bff.portalBilling.listPortalPayments(customer), { list: true });
    // The list is the customer's payments (by party), so the staff-recorded one may be in it too.
    expect(mine.map((x) => x.id)).toContain(p3.portalPaymentId);

    const finance2 = await session('finance2');
    const before = await seen(() => bff.receivables.getPayment(finance2, p3.portalPaymentId));
    const verified = await seen(() =>
      bff.receivables.verifyPayment(
        finance2,
        p3.portalPaymentId,
        { expectedVersion: before.version },
        key(),
      ),
    );
    expect(verified.status).toBe('verified');
    await seen(
      () =>
        bff.receivables.allocatePayment(
          finance2,
          p3.portalPaymentId,
          { lines: [{ invoiceId: p3.manualId, amount: PORTAL_PAID }] },
          key(),
        ),
      { list: true },
    );

    // The customer sees the receipt number and the smaller open amount, both derived by the server.
    const after = await seen(() => bff.portalBilling.listPortalPayments(customer), { list: true });
    expect(after.find((x) => x.id === p3.portalPaymentId)).toMatchObject({ status: 'verified' });
    const settlement = await seen(
      () => bff.portalBilling.getPortalInvoiceSettlement(customer, p3.manualId),
      { allowDropped: ['number', 'kind', 'customerId', 'issueDate', 'allocatedAmount'] },
    );
    expect(settlement.openAmount).toBe(
      new Decimal(MANUAL_TOTAL).minus(PORTAL_PAID).toFixed(2, Decimal.ROUND_HALF_UP),
    );
  }, 90_000);

  it('18. a credit note and a debit note through the client; the draft debit note stays hidden from the portal', async () => {
    const finance2 = await session('finance2');
    const manual = await openInvoice(p3.manualId);
    const line = manual.lines[0]!;
    const quarter = new Decimal(line.quantity).div(4).toFixed(4, Decimal.ROUND_HALF_UP);

    const credit = await seen(() =>
      bff.billing.createCreditNote(
        finance2,
        {
          originalInvoiceId: p3.manualId,
          reason: 'Contract test: a quarter of the add-on was not delivered',
          lines: [{ originalLineNo: line.lineNo, quantity: quarter }],
        },
        key(),
      ),
    );
    expect(credit.invoice).toMatchObject({
      kind: 'credit_note',
      status: 'draft',
      originalInvoiceId: p3.manualId,
    });
    p3.creditNoteId = credit.invoice.id;
    expect(await submitApproveIssue(p3.creditNoteId, 'finance2')).toMatch(/^CN-/);

    const debit = await seen(() =>
      bff.billing.createDebitNote(
        finance2,
        {
          originalInvoiceId: p3.manualId,
          reason: 'Contract test: an extra domain renewal',
          lines: [
            {
              description: 'Domain renewal',
              uom: 'lot',
              quantity: '1',
              unitPrice: '500.00',
              taxCodeId: p3.vat13Id,
            },
          ],
        },
        key(),
      ),
    );
    expect(debit.invoice).toMatchObject({ kind: 'debit_note', status: 'draft' });
    p3.debitNoteId = debit.invoice.id;

    const notes = await seen(
      () => bff.billing.listInvoices(finance2, { kind: 'credit_note', customerId: p3.customerId }),
      { list: true },
    );
    expect(notes.map((i) => i.id)).toEqual([p3.creditNoteId]);

    // A draft is not the customer's: the API answers 404, and the portal client passes that on as an ApiError.
    const customer = await portalSession();
    const refused = await bff.portalBilling.getPortalInvoice(customer, p3.debitNoteId).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(bff.PortalApiError);
    expect((refused as InstanceType<typeof bff.PortalApiError>).status).toBe(404);
    const listed = await bff.portalBilling.listPortalInvoices(customer);
    expect(listed.map((i) => i.id)).not.toContain(p3.debitNoteId);
    expect(listed.map((i) => i.id)).toContain(p3.creditNoteId);
  }, 90_000);

  it('19. receivables: aging, statement (all, then open only in NPR) and the customer advance', async () => {
    const finance = await session('finance');
    const creditTotal = new Decimal((await openInvoice(p3.creditNoteId)).invoice.totals.total);
    // From the documents, not read back from the ledger: the advance is paid, the add-on less payment and credit.
    const expectedOpen = new Decimal(MANUAL_TOTAL)
      .minus(PORTAL_PAID)
      .minus(creditTotal)
      .toFixed(2, Decimal.ROUND_HALF_UP);

    const everything = await seen(
      () => bff.receivables.getCustomerStatement(finance, p3.customerId),
      { list: true },
    );
    expect(everything.map((r) => r.invoiceId)).toEqual(
      expect.arrayContaining([p3.advanceId, p3.manualId]),
    );
    const open: InvoiceSettlement[] = await seen(
      () =>
        bff.receivables.getCustomerStatement(finance, p3.customerId, {
          openOnly: true,
          currency: 'NPR',
        }),
      { list: true },
    );
    expect(open.map((r) => r.invoiceId)).toEqual([p3.manualId]);
    expect(open[0]!.openAmount).toBe(expectedOpen);

    const aging = await seen(() => bff.receivables.getAging(finance));
    const row = aging.rows.find((r) => r.customerId === p3.customerId && r.currency === 'NPR');
    expect(row, JSON.stringify(aging)).toBeDefined();
    expect(row!.totalOpen).toBe(expectedOpen);

    const advance = await seen(() => bff.receivables.getCustomerAdvance(finance, p3.customerId), {
      list: true,
    });
    expect(advance).toEqual([{ customerId: p3.customerId, currency: 'NPR', amount: STAFF_EXCESS }]);
  });

  it('20. a refusal on a P3 route reaches the workspace as an ApiError with the contract error envelope', async () => {
    const error = await bff.billing.getInvoice(await session('finance'), randomUUID()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(bff.ApiError);
    const failure = error as InstanceType<typeof bff.ApiError>;
    expect(failure.status).toBe(404);
    expect(ErrorBodySchema.safeParse(failure.body).success, JSON.stringify(failure.body)).toBe(
      true,
    );
  });
});
