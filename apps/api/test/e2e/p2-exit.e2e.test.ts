// P2 exit test (P2-BUILD-PLAN "Exit test") over real HTTP: a lead becomes a customer and an opportunity, a USD
// quotation with a 13% discount is routed accountant -> finance -> management -> founder (step-up), rendered,
// scanned clean, sent with a portal link only, and accepted by the customer in the portal; the opportunity is
// Won and the audit chain verifies.
//
// Real: AppModule and WorkerModule (startApp, startWorker), the JwtVerifier against the test issuer, Postgres as
// bos_app, the production seed (role grants, the quotation_version workflow, VAT13), the render sweeper as the
// worker wires it, the BullMQ scan processor, the outbox. Faked: Gotenberg (an HTTP server answering a fixed
// PDF) and clamd (the fake the documents tests use). Shortcut: the customer's portal login (its idp_orgs row and
// the portal user) is seeded by SQL, because P2 has no route that grants portal access (it waits for KYB).
//
// Own tenant (createIsolatedStaffOrg): the approver lookup counts everyone holding a role in the tenant.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  ChainVerifyDtoSchema,
  ContactDtoSchema,
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CustomerDtoSchema,
  CustomerQuotationViewSchema,
  ErrorBodySchema,
  LeadDtoSchema,
  PortalQuotationListItemSchema,
  PreviewResultSchema,
  QuotationDtoSchema,
  QuotationVersionDtoSchema,
  type AddressLines,
  type ApprovalRequestDto,
  type PartyPhoneInput,
  type PrintAddress,
  type QuotationVersionDto,
} from '@bos/contracts';
import { createParty, userRoles } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { systemActor, withTx } from '../../src/platform/db/tx';
import { QuotationRenderSweeper } from '../../src/modules/quotations/render/quotation-render.sweeper';
import { CLIENT_ID, startApp, type TestApp } from './support/app';
import {
  createIsolatedStaffOrg,
  minimalPdf,
  pollUntil,
  seedApprovalsWorld,
  seedPortalLogin,
  type ApprovalsWorld,
  type PersonaKey,
  type PortalLogin,
} from './support/fixtures';
import { startWorker, type TestWorker } from './support/worker';

const e2e = inject('e2e');

const PORTAL = 'http://portal.e2e.test';
const USD_RATE = '133.5';
// The entity's address prints with its country; a customer's address holds only the lines, its country is its own
// field (FX9).
const ENTITY_ADDRESS: PrintAddress = { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const CUSTOMER_ADDRESS: AddressLines = { line: '1 Durbar Marg', city: 'Kathmandu' };
const BUYER_EMAIL = 'buyer@himal-traders.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let t: TestApp;
let worker: TestWorker;
let clamd: FakeClamd;
let gotenberg: Server;
let world: ApprovalsWorld;
let isolated: Awaited<ReturnType<typeof createIsolatedStaffOrg>>;
let filesRoot: string;

/** Today in Kathmandu (the money rules and valid_until are Kathmandu dates), and `days` after it. */
const kathmanduDay = (shiftDays = 0): string => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
};

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
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-p2-exit-'));

  isolated = await createIsolatedStaffOrg(e2e);
  world = await seedApprovalsWorld({ ...e2e, ...isolated }, 'e2e-p2-exit');
  // The salesperson also holds the accountant role, so step 6 is a real separation-of-duties refusal: sales is
  // eligible for the accountant step by role and refused only because they prepared the quotation. The
  // accountant persona stays the step's one eligible approver.
  await withTx(
    drizzle({ client: world.pool }),
    { tenantId: isolated.tenantId, organizationId: isolated.staff.organizationId },
    systemActor('e2e-p2-exit-seed'),
    (tx) =>
      tx.insert(userRoles).values({
        tenantId: isolated.tenantId,
        userId: world.personas.sales.userId,
        roleKey: 'accountant',
        source: 'zitadel',
      }),
  );

  // Read by AppModule and WorkerModule when they are imported, so set before either boots.
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-p2-exit.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-p2-exit-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: PORTAL,
    GOTENBERG_URL: `http://127.0.0.1:${(gotenberg.address() as AddressInfo).port}`,
  });
  t = await startApp();
  worker = await startWorker();
});

afterAll(async () => {
  // Worker first (its BullMQ handles would keep the process alive), then the app, then the fakes.
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

async function auth(key: PersonaKey, roles?: string[]): Promise<string> {
  const persona = world.personas[key];
  const token = await t.token(isolated.staff, {
    userId: persona.sub,
    roles: roles ?? persona.tokenRoles,
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

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const show = (res: { status: number; body: unknown }): string =>
  `${res.status} ${JSON.stringify(res.body)}`;

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

// The portal's `display.numberSystems` block is keyed by currency code (D30, per-currency number grouping, migration
// 0050), so the key `NPR` is a code, not an NPR equivalent. Same exemption as packages/contracts portal.test.ts.
const CURRENCY_CODE_KEYS = new Set(['NPR', 'INR', 'USD']);

/**
 * Every word of every key in a JSON value (camelCase and snake_case split), as portal.service.test does. A key that
 * is exactly a currency code is skipped; the value-level FX-rate check in expectNoInternalFields still covers rates.
 */
function keyWords(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keyWords(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!CURRENCY_CODE_KEYS.has(k)) {
        out.push(
          ...k
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .toLowerCase()
            .split('_'),
        );
      }
      keyWords(v, out);
    }
  }
  return out;
}

function expectNoInternalFields(body: unknown): void {
  const words = keyWords(body);
  for (const word of CUSTOMER_VIEW_FORBIDDEN_WORDS) expect(words, word).not.toContain(word);
  // The FX rate never reaches the customer, under any key.
  expect(JSON.stringify(body)).not.toContain(USD_RATE);
}

async function getVersion(authz: string): Promise<QuotationVersionDto> {
  const res = await t
    .http()
    .get(`/v1/quotations/${s.quotationId}/versions/${s.versionId}`)
    .set('authorization', authz);
  expect(res.status, show(res)).toBe(200);
  return QuotationVersionDtoSchema.parse(res.body);
}

async function getRequest(authz: string): Promise<ApprovalRequestDto> {
  const res = await t
    .http()
    .get(`/v1/approvals/requests/${s.requestId}`)
    .set('authorization', authz);
  expect(res.status, show(res)).toBe(200);
  return ApprovalRequestDtoSchema.parse(res.body);
}

function approve(authz: string, expectedVersion: number, headers: Record<string, string> = {}) {
  return t
    .http()
    .post(`/v1/approvals/requests/${s.requestId}/actions`)
    .set('authorization', authz)
    .set('idempotency-key', randomUUID())
    .set(headers)
    .send({ action: 'approve', expectedVersion });
}

function send(expectedVersion: number) {
  return t
    .http()
    .post(`/v1/quotations/${s.quotationId}/versions/${s.versionId}/send`)
    .set('authorization', s.salesAuth)
    .set('idempotency-key', randomUUID())
    .send({ recipientContactId: s.contactId, expectedVersion });
}

async function opportunityRow(): Promise<{ stage: string; won: string | null }> {
  const { rows } = await world.pool.query<{ stage: string; won: string | null }>(
    'SELECT stage, won_quotation_version_id AS won FROM app.opportunities WHERE id = $1',
    [s.opportunityId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function sentEmails(): Promise<{ to_email: string; template: string; body_text: string }[]> {
  const { rows } = await world.pool.query<{
    to_email: string;
    template: string;
    body_text: string;
  }>(
    'SELECT to_email, template, body_text FROM app.outbox WHERE tenant_id = $1 AND dedupe_key = $2',
    [isolated.tenantId, `quotation.sent:${s.versionId}`],
  );
  return rows;
}

// ------------------------------------------------------------------------------------------- the journey

// Shared across the ordered steps below (one story, told step by step).
const s = {
  salesAuth: '',
  opportunityId: '',
  customerId: '',
  contactId: '',
  quotationId: '',
  versionId: '',
  requestId: '',
  renderedSha256: '',
  login: undefined as PortalLogin | undefined,
};

describe('P2 exit: lead to won over HTTP', () => {
  it('0. the founder sets the entity address and a fresh USD rate', async () => {
    const founder = await auth('founder');
    const address = await t
      .http()
      .put('/v1/admin/settings/entity.address')
      .set('authorization', founder)
      .send({ value: ENTITY_ADDRESS });
    expect([200, 204], show(address)).toContain(address.status);

    const rate = await t
      .http()
      .post('/v1/admin/fx-rates')
      .set('authorization', founder)
      .send({ currency: 'USD', rateNpr: USD_RATE, rateDate: kathmanduDay() });
    expect(rate.status, show(rate)).toBe(201);
  });

  it('1. sales creates a lead, qualifies it and converts it into a new customer and an opportunity', async () => {
    s.salesAuth = await auth('sales');
    const created = await t.http().post('/v1/leads').set('authorization', s.salesAuth).send({
      title: 'Website for Himal Traders',
      source: 'referral',
      companyName: 'Himal Traders Pvt. Ltd.',
      contactName: 'Sita Rai',
      country: 'NP',
      email: BUYER_EMAIL,
    });
    expect(created.status, show(created)).toBe(201);
    let lead = LeadDtoSchema.parse(created.body);
    expect(lead.stage).toBe('new');

    for (const stage of ['contacted', 'qualified'] as const) {
      const moved = await t
        .http()
        .patch(`/v1/leads/${lead.id}/stage`)
        .set('authorization', s.salesAuth)
        .send({
          stage,
          expectedVersion: lead.version,
          ...(stage === 'contacted'
            ? { contactActivity: { kind: 'call', body: 'Intro call' } }
            : {}),
        });
      expect(moved.status, show(moved)).toBe(200);
      lead = LeadDtoSchema.parse(moved.body);
      expect(lead.stage).toBe(stage);
    }

    const converted = await t
      .http()
      .post(`/v1/leads/${lead.id}/convert`)
      .set('authorization', s.salesAuth)
      .set('idempotency-key', randomUUID())
      .send({
        customer: {
          mode: 'create',
          customer: {
            legalName: 'Himal Traders Pvt. Ltd.',
            country: 'NP',
            address: CUSTOMER_ADDRESS,
          },
        },
        contact: {
          mode: 'create',
          contact: { fullName: 'Sita Rai', email: BUYER_EMAIL, country: 'NP' },
        },
        opportunityName: 'Himal Traders website',
        expectedVersion: lead.version,
      });
    expect(converted.status, show(converted)).toBe(201);
    const body = converted.body as { opportunityId: string; customerId: string };
    expect(Object.keys(body).sort()).toEqual(['customerId', 'opportunityId']);
    expect(body.opportunityId).toMatch(UUID);
    expect(body.customerId).toMatch(UUID);
    s.opportunityId = body.opportunityId;
    s.customerId = body.customerId;

    const contacts = await t
      .http()
      .get(`/v1/customers/${s.customerId}/contacts`)
      .set('authorization', s.salesAuth);
    expect(contacts.status, show(contacts)).toBe(200);
    const list = contacts.body as { id: string }[];
    expect(list).toHaveLength(1);
    s.contactId = list[0]!.id;
    expect((await opportunityRow()).stage).toBe('qualified');
  });

  it('2. sales drafts a USD quotation with a 13% discount; preview routes accountant, finance, management, founder', async () => {
    const codes = await t.http().get('/v1/tax-codes').set('authorization', s.salesAuth);
    expect(codes.status, show(codes)).toBe(200);
    const codeList = (
      Array.isArray(codes.body) ? codes.body : (codes.body as { items: unknown[] }).items
    ) as { id: string; code: string }[];
    const vat13 = codeList.find((c) => c.code === 'VAT13');
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
    const discount = { mode: 'pct', value: '13' } as const;
    const created = await t
      .http()
      .post('/v1/quotations')
      .set('authorization', s.salesAuth)
      .set('idempotency-key', randomUUID())
      .send({
        opportunityId: s.opportunityId,
        contactId: s.contactId,
        currency: 'USD',
        issueDate: kathmanduDay(),
        validUntil: kathmanduDay(30),
        lines,
        discount,
      });
    expect(created.status, show(created)).toBe(201);
    const quotation = QuotationDtoSchema.parse(created.body);
    expect(quotation.customerId).toBe(s.customerId);
    s.quotationId = quotation.id;
    s.versionId = quotation.currentVersionId;

    const draft = await getVersion(s.salesAuth);
    expect(draft).toMatchObject({ status: 'draft', currency: 'USD', discount });

    const preview = await t
      .http()
      .post(`/v1/quotations/${s.quotationId}/versions/${s.versionId}/preview`)
      .set('authorization', s.salesAuth)
      .send({ currency: 'USD', discount, lines });
    expect(preview.status, show(preview)).toBe(200);
    const result = PreviewResultSchema.parse(preview.body);
    // USD 10,000 less 13% plus VAT 13% at 133.5 is about NPR 13.1 lakh: over 10 lakh, so the founder joins.
    expect(result.nprSnapshot).toBeTruthy();
    expect(result.route.blocked).toBe(false);
    expect(result.route.steps.map((st) => st.roleKey)).toEqual([
      'accountant',
      'finance',
      'management',
      'founder',
    ]);
  });

  it('3. sales submits; sending before approval is refused with 409', async () => {
    const draft = await getVersion(s.salesAuth);
    const submitted = await t
      .http()
      .post(`/v1/quotations/${s.quotationId}/versions/${s.versionId}/submit`)
      .set('authorization', s.salesAuth)
      .set('idempotency-key', randomUUID())
      .send({ expectedVersion: draft.version });
    expect(submitted.status, show(submitted)).toBe(200);
    const version = QuotationVersionDtoSchema.parse(submitted.body);
    expect(version.status).toBe('submitted');
    expect(version.approvalRequestId).not.toBeNull();
    s.requestId = version.approvalRequestId!;

    // Negative journey: an unapproved version cannot be sent. Nothing is queued and the opportunity stays put.
    const early = await send(version.version);
    expect(early.status, show(early)).toBe(409);
    expect(await sentEmails()).toEqual([]);
    expect((await opportunityRow()).stage).toBe('qualified');
    expect((await getVersion(s.salesAuth)).status).toBe('submitted');
  });

  it('3b. no self-approval (exit step 6): the submitter is refused on the step their own role could decide', async () => {
    const before = await getRequest(await auth('founder'));
    expect(before).toMatchObject({ status: 'pending', currentSeq: 1 });

    // With the accountant role in the token too, sales is eligible for step 1 by role; separation of duties
    // is the only thing that refuses them.
    const asAccountant = await approve(
      await auth('sales', ['sales', 'accountant']),
      before.version,
    );
    expect(asAccountant.status, show(asAccountant)).toBe(403);
    expect(errorOf(asAccountant.body)).toMatchObject({
      code: 'forbidden',
      reason: 'separation_of_duties',
    });

    // Plain sales has no approver grant, so refusal conceals whether the request exists.
    const asSales = await approve(s.salesAuth, before.version);
    expect(asSales.status, show(asSales)).toBe(404);

    const after = await getRequest(await auth('founder'));
    expect(after).toMatchObject({ status: 'pending', currentSeq: 1, version: before.version });
  });

  it('4. accountant, finance and management approve their steps', async () => {
    for (const [key, seq] of [
      ['accountant', 1],
      ['finance', 2],
      ['management', 3],
    ] as const) {
      const authz = await auth(key);
      const before = await getRequest(authz);
      expect(before.currentSeq, `${key} should be the current step`).toBe(seq);
      const res = await approve(authz, before.version);
      expect(res.status, show(res)).toBe(200);
      expect(ApprovalRequestDtoSchema.parse(res.body).currentSeq).toBe(seq + 1);
    }
  });

  it('5. the founder needs a fresh ID token (401 step_up_required without one); with it the version is approved', async () => {
    const founder = await auth('founder');
    const before = await getRequest(founder);
    expect(before).toMatchObject({ status: 'pending', currentSeq: 4 });

    const bare = await approve(founder, before.version);
    expect(bare.status, show(bare)).toBe(401);
    expect(errorOf(bare.body).code).toBe('step_up_required');
    expect((await getRequest(founder)).version).toBe(before.version);

    const idToken = await t.issuer.mintIdToken({
      sub: world.personas.founder.sub,
      authTime: nowSeconds() - 10,
      audience: CLIENT_ID,
    });
    const res = await approve(founder, before.version, { 'x-bos-id-token': idToken });
    expect(res.status, show(res)).toBe(200);
    expect(ApprovalRequestDtoSchema.parse(res.body).status).toBe('approved');

    const version = await getVersion(s.salesAuth);
    expect(version.status).toBe('approved');
  });

  it('7. the worker renders the PDF (fake Gotenberg) and the scan marks it clean (fake clamd)', async () => {
    // The sweeper the worker wired, run now instead of waiting for its one-minute schedule. The scheduled run
    // may claim the version first (this sweep then finds nothing); either way the poll below waits for the
    // result. A failed render is retried only after FAILED_RETRY_MS (5 min), far past the poll, so a failure
    // from either run stops the test at once, naming the kind or the state, instead of timing out.
    const swept = await worker.app.get(QuotationRenderSweeper).sweep();
    expect(swept.failures, JSON.stringify(swept)).toEqual([]);
    const clean = await pollUntil(
      'the rendered quotation PDF to scan clean',
      async () => {
        const { rows } = await world.pool.query<{ render_state: string }>(
          'SELECT render_state FROM app.quotation_versions WHERE id = $1',
          [s.versionId],
        );
        const renderState = rows[0]?.render_state;
        if (renderState === 'failed') {
          throw new Error(
            `the render failed (render_state failed); this sweep: ${JSON.stringify(swept)}`,
          );
        }
        const v = await getVersion(s.salesAuth);
        if (v.renderedScanStatus === 'infected' || v.renderedScanStatus === 'scan_failed') {
          throw new Error(`the rendered PDF scan ended ${v.renderedScanStatus}`);
        }
        return {
          done: v.renderedScanStatus === 'clean' ? v : undefined,
          last: { renderState, version: v },
        };
      },
      60_000,
      500,
    );
    expect(clean.renderedDocumentId).not.toBeNull();
    expect(clean.renderedSha256).toMatch(/^[0-9a-f]{64}$/);
    s.renderedSha256 = clean.renderedSha256!;
  }, 90_000);

  it('8. sales sends to the customer contact: one email with a portal link only; the opportunity is at quotation_sent', async () => {
    const approved = await getVersion(s.salesAuth);
    const res = await send(approved.version);
    expect(res.status, show(res)).toBe(200);
    const sent = QuotationVersionDtoSchema.parse(res.body);
    expect(sent.status).toBe('sent');

    const emails = await sentEmails();
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email).toMatchObject({ template: 'quotation.sent', to_email: BUYER_EMAIL });
    // The portal's `/quotations/:id` is a version id (PortalService.get), so the link names the version just sent
    // (commit 934a216a; quotation-send.service.ts `linkPath`). Stale before: it expected the parent quotation id.
    expect(email.body_text).toContain(`${PORTAL}/quotations/${s.versionId}`);
    // A link, never the file: no document id, no PDF name, no download URL.
    expect(email.body_text).not.toContain(approved.renderedDocumentId!);
    expect(email.body_text.toLowerCase()).not.toContain('.pdf');
    expect((await opportunityRow()).stage).toBe('quotation_sent');
  });

  it('9a. a portal user of another party gets 404 for this quotation and does not see it listed', async () => {
    const other = await createParty(world.pool, { tenantId: isolated.tenantId, kind: 'customer' });
    const stranger = await seedPortalLogin(
      e2e,
      { tenantId: isolated.tenantId, organizationId: isolated.staff.organizationId },
      other.partyId,
    );
    const authz = await portalAuth(stranger);

    const list = await t.http().get('/v1/portal/quotations').set('authorization', authz);
    expect(list.status, show(list)).toBe(200);
    expect((list.body as { id: string }[]).map((q) => q.id)).not.toContain(s.versionId);

    const view = await t
      .http()
      .get(`/v1/portal/quotations/${s.versionId}`)
      .set('authorization', authz);
    expect(view.status, show(view)).toBe(404);

    const accept = await t
      .http()
      .post(`/v1/portal/quotations/${s.versionId}/accept`)
      .set('authorization', authz)
      .set('idempotency-key', randomUUID())
      .send({ acceptedByName: 'Not The Buyer', confirm: true });
    expect(accept.status, show(accept)).toBe(404);
  });

  it('9b. the customer lists and opens the quotation (no internal field), then accepts it', async () => {
    s.login = await seedPortalLogin(
      e2e,
      { tenantId: isolated.tenantId, organizationId: isolated.staff.organizationId },
      s.customerId,
    );
    const authz = await portalAuth(s.login);

    const list = await t.http().get('/v1/portal/quotations').set('authorization', authz);
    expect(list.status, show(list)).toBe(200);
    const items = (list.body as unknown[]).map((i) => PortalQuotationListItemSchema.parse(i));
    expect(items.map((i) => i.id)).toEqual([s.versionId]);
    expectNoInternalFields(list.body);

    const view = await t
      .http()
      .get(`/v1/portal/quotations/${s.versionId}`)
      .set('authorization', authz);
    expect(view.status, show(view)).toBe(200);
    const customerView = CustomerQuotationViewSchema.parse(view.body);
    expectNoInternalFields(view.body);
    // The only `npr` key in the body is the currency code that keys the number-grouping block: no NPR amount, no rate.
    expect(Object.keys(customerView.display.numberSystems).sort()).toEqual(['INR', 'NPR', 'USD']);
    // The file the customer would download carries the hash the render stored (the download route is PA-doc).
    expect(customerView.file?.sha256).toBe(s.renderedSha256);

    const accept = await t
      .http()
      .post(`/v1/portal/quotations/${s.versionId}/accept`)
      .set('authorization', authz)
      .set('idempotency-key', randomUUID())
      .send({ acceptedByName: 'Sita Rai', confirm: true });
    expect(accept.status, show(accept)).toBe(201);
    expect(accept.body).toMatchObject({ id: s.versionId, status: 'accepted' });
  });

  it('10. the version is accepted, the opportunity is won, the acceptance is the customer’s, the audit chain verifies', async () => {
    expect((await getVersion(s.salesAuth)).status).toBe('accepted');
    expect(await opportunityRow()).toEqual({ stage: 'won', won: s.versionId });

    const { rows } = await world.pool.query<{
      outcome: string;
      actor_kind: string;
      actor_id: string;
      accepted_by_name: string | null;
    }>(
      `SELECT outcome, actor_kind, actor_id, accepted_by_name
         FROM app.quotation_acceptances WHERE version_id = $1`,
      [s.versionId],
    );
    expect(rows).toEqual([
      {
        outcome: 'accepted',
        actor_kind: 'customer_user',
        actor_id: s.login!.userId,
        accepted_by_name: 'Sita Rai',
      },
    ]);

    const month = new Date().toISOString().slice(0, 7);
    const verify = await t
      .http()
      .get('/v1/audit/verify')
      .query({ month })
      .set('authorization', await auth('finance'));
    expect(verify.status, show(verify)).toBe(200);
    const chain = ChainVerifyDtoSchema.parse(verify.body);
    expect(chain).toMatchObject({
      tenantId: isolated.tenantId,
      month,
      ok: true,
      firstBadSeq: null,
    });
    expect(chain.rows).toBeGreaterThan(0);
  });

  // FX9: a foreign party needs no Nepal PAN, and each phone of a person carries its own country. Self-contained (its
  // own customer and contact, after the journey), so a failed journey step cannot hide it.
  it('11. a US customer without a PAN is created and read back; its contact keeps a US and a Nepal phone', async () => {
    const sales = await auth('sales');
    const phones: PartyPhoneInput[] = [
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
      { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: false },
    ];
    const created = await t
      .http()
      .post('/v1/customers')
      .set('authorization', sales)
      .set('idempotency-key', randomUUID())
      .send({
        legalName: 'Pacific Coast Imports Inc.',
        country: 'US',
        address: { line: '500 Market Street', city: 'San Francisco' },
        contact: {
          fullName: 'Dana Whitfield',
          email: 'dana@pacific-coast-imports.test',
          country: 'US',
          phones,
        },
      });
    expect(created.status, show(created)).toBe(201);
    const customer = CustomerDtoSchema.parse(created.body);
    expect(customer).toMatchObject({
      legalName: 'Pacific Coast Imports Inc.',
      panVatNo: null,
      country: 'US',
      address: { line: '500 Market Street', city: 'San Francisco' },
    });

    const read = await t.http().get(`/v1/customers/${customer.id}`).set('authorization', sales);
    expect(read.status, show(read)).toBe(200);
    expect(CustomerDtoSchema.parse(read.body)).toMatchObject({
      id: customer.id,
      panVatNo: null,
      country: 'US',
      address: { line: '500 Market Street', city: 'San Francisco' },
    });

    const contacts = await t
      .http()
      .get(`/v1/customers/${customer.id}/contacts`)
      .set('authorization', sales);
    expect(contacts.status, show(contacts)).toBe(200);
    const list = (contacts.body as unknown[]).map((c) => ContactDtoSchema.parse(c));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ fullName: 'Dana Whitfield', country: 'US', isPrimary: true });
    // Primary first, then the saved order: the same two rows, each with its own country.
    expect(list[0]!.phones).toEqual(phones);
  });
});
