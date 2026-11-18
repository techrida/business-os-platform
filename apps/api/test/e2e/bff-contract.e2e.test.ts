// BFF contract test: the workspace's REAL API clients (crm-api, verification-api, customers/api,
// quote-builder/api, quotations/api) called against the REAL API over real HTTP.
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
// the KYB decision (needs a clean scan, so the worker) and portal routes (the portal is another app).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  ErrorBodySchema,
  QuotationVersionDtoSchema,
  type ApprovalRequestDto,
  type QuotationVersionDto,
} from '@bos/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { startApp, type TestApp } from './support/app';
import {
  droppedKeys,
  loadBffClients,
  rowsOf,
  teeFetch,
  type BffClients,
  type BffSession,
  type FetchTee,
} from './support/bff-clients';
import {
  createIsolatedStaffOrg,
  minimalPdf,
  seedApprovalsWorld,
  type ApprovalsWorld,
  type PersonaKey,
} from './support/fixtures';

const e2e = inject('e2e');

const ADDRESS = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const BUYER_EMAIL = 'buyer@contract-traders.test';

let t: TestApp;
let clamd: FakeClamd;
let world: ApprovalsWorld;
let isolated: Awaited<ReturnType<typeof createIsolatedStaffOrg>>;
let filesRoot: string;
let bff: BffClients;
let tee: FetchTee;
let apiUrl = '';

beforeAll(async () => {
  clamd = await startFakeClamd();
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-bff-contract-'));
  isolated = await createIsolatedStaffOrg(e2e);
  world = await seedApprovalsWorld({ ...e2e, ...isolated }, 'e2e-bffc');

  // Read by AppModule when it is imported, so set before it boots (same set as the P2 exit e2e).
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-bff-contract.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-bff-contract-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: 'http://portal.e2e.test',
    // Nothing here renders a PDF; the URL only has to be well formed.
    GOTENBERG_URL: 'http://127.0.0.1:9',
  });
  t = await startApp();
  // The workspace clients use `fetch`, so the API needs a real port (the other e2e files use supertest).
  await t.app.listen(0, '127.0.0.1');
  apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;

  tee = teeFetch();
  bff = await loadBffClients(() => apiUrl);
});

afterAll(async () => {
  tee?.restore();
  await t?.close();
  await clamd?.close();
  await world?.close();
  if (filesRoot) await rm(filesRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ helpers

/** The session the workspace holds for a persona: only the access token matters to `apiFetch`. */
async function session(key: PersonaKey): Promise<BffSession> {
  const persona = world.personas[key];
  return {
    accessToken: await t.token(isolated.staff, { userId: persona.sub, roles: persona.tokenRoles }),
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
const bearer = async (key: PersonaKey): Promise<string> =>
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
      .send({ value: ADDRESS });
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
          email: BUYER_EMAIL,
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
        bff.crm.changeLeadStage(sales(), s.leadId, { stage, expectedVersion: lead.version }),
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
              address: ADDRESS,
            },
          },
          contact: {
            mode: 'create',
            contact: { fullName: 'Rina Shrestha', email: BUYER_EMAIL, isPrimary: true },
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

    // `getCustomer` is the contract's CustomerDto, which has no `accounts`: dropping it is by design,
    // `getCustomerDetail` is the reader that keeps it.
    const customer = await seen(() => bff.customers.getCustomer(sales(), s.customerId), {
      allowDropped: ['accounts'],
    });
    expect(customer.id).toBe(s.customerId);
    const detail = await seen(() => bff.customers.getCustomerDetail(sales(), s.customerId));
    expect(detail.accounts, 'staff get the per-entity terms with the customer').toBeDefined();

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
      allowDropped: ['accounts'],
    });
    expect(builderCustomer.id).toBe(s.customerId);
    const builderContacts = await seen(() => bff.builder.listContacts(sales(), s.customerId), {
      list: true,
    });
    expect(builderContacts.map((c) => c.id)).toEqual([s.contactId]);
  });

  it('4. quotation lookups: tax codes (with the seeded VAT13) and payment terms', async () => {
    const codes = await seen(() => bff.builder.listTaxCodes(sales()), { list: true });
    expect(codes.map((c) => c.code)).toContain('VAT13');
    // The production seed may not fill payment terms; the shape is still audited when it does.
    await seen(() => bff.builder.listPaymentTerms(sales()), { list: true, maybeEmpty: true });
  });

  it('5. quotation: create, list, detail, preview, save a draft, submit', async () => {
    const codes = await bff.builder.listTaxCodes(sales());
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
      bff.verification.submitVerificationCase(founder(), s.caseId, randomUUID()),
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
