// P3 model test (P3-BUILD-PLAN done check 9): a seeded random walk of 200 money commands over real HTTP, with the
// receivables invariants asserted after every one of them.
//
// Commands, drawn by a seeded RNG (mulberry32; the seed is printed, override it with P3_MODEL_SEED, the length with
// P3_MODEL_STEPS) among those the current state allows: draft / submit / approve / issue a tax invoice, draft / issue
// a proforma, draft / submit / approve / issue a credit note on an issued invoice with room, record / verify / reject /
// reverse a payment, allocate / deallocate. About one command in five is deliberately wrong (issue unapproved,
// over-allocate, allocate an unverified payment, self-verify, reverse an unverified payment, an oversized credit note,
// a credit note on a draft): the server must refuse it.
//
// After every command, per customer:
//   open debits - open credits = issued invoices + debit notes - credit notes - verified settles + reversals
// (left side from open_item_balances, right side from invoices and payments); the aging report's open total equals
// the open receivable debits; every issued tax invoice, debit or credit note and every verified (or reversed) payment
// has exactly one open item of its amount, and drafts, proformas, discarded invoices and submitted or rejected payments
// have none. A refused command (any 4xx) leaves the ledger, the documents, the payments and the approvals unchanged.
// A 5xx, or a refusal of a command the model expected to pass, fails the test with the seed and the step.
//
// Real: AppModule over HTTP (startApp), the JwtVerifier against the test issuer, Postgres as bos_app, the production
// seed (role grants, invoice and credit-note workflows, VAT13). The services are driven through their routes, not
// `app.get(Service)`: they read the request context (requestTx(), the principal for authz.assert), which only the HTTP
// pipeline sets. Faked: Gotenberg and clamd (not exercised; set so the app boots as in p3-exit).
// Shortcuts, each declared where it is taken:
// - payment proofs are seeded clean by SQL (seedCleanProof), the rows payments.integration.test.ts seeds; p3-exit
//   covers the upload and the scan.
//
// Cast (support/p3-fixtures.ts): `preparer` drafts and submits tax invoices and proformas and records payments;
// `accountant` and `finance` approve; `finance` issues, rejects and reverses; `finance2` drafts and submits credit notes,
// verifies payments and allocates. `finance2` also records the payments the self-verification refusal needs.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  ArAgingReportSchema,
  InvoiceDetailSchema,
  LeadDtoSchema,
} from '@bos/contracts';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { CLIENT_ID, startApp, type TestApp } from './support/app';
import { minimalPdf } from './support/fixtures';
import {
  seedCleanProof,
  seedP3World,
  type P3PersonaKey,
  type P3World,
} from './support/p3-fixtures';

const e2e = inject('e2e');

const SEED = Number(process.env.P3_MODEL_SEED ?? '20261109');
const STEPS = Number(process.env.P3_MODEL_STEPS ?? '200');
const ADDRESS = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };

let t: TestApp;
let clamd: FakeClamd;
let gotenberg: Server;
let world: P3World;
let filesRoot: string;
let vat13 = '';
const customers: string[] = [];
const pdf = minimalPdf();

const kathmanduDay = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());

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
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-p3-model-'));

  world = await seedP3World(e2e, 'e2e-p3-model');

  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-p3-model.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-p3-model-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
    PORTAL_PUBLIC_URL: 'http://portal.e2e.test',
    GOTENBERG_URL: `http://127.0.0.1:${(gotenberg.address() as AddressInfo).port}`,
  });
  t = await startApp();
});

afterAll(async () => {
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

/** mulberry32: a small seeded PRNG, so a failing walk replays with the same seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
function pick<T>(xs: readonly T[]): T {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error('pick from an empty list');
  return x;
}

async function auth(key: P3PersonaKey): Promise<string> {
  const persona = world.personas[key];
  const token = await t.token(world.isolated.staff, {
    userId: persona.sub,
    roles: persona.tokenRoles,
  });
  return `Bearer ${token}`;
}

interface Res {
  status: number;
  body: unknown;
}
const show = (res: Res): string => `${res.status} ${JSON.stringify(res.body)}`;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function post(as: P3PersonaKey, path: string, body: unknown): Promise<Res> {
  const res = await t
    .http()
    .post(path)
    .set('authorization', await auth(as))
    .set('idempotency-key', randomUUID())
    .send(body as object);
  return { status: res.status, body: res.body as unknown };
}

const APPROVER_OF: Partial<Record<string, P3PersonaKey>> = {
  accountant: 'accountant',
  finance: 'finance',
  management: 'management',
  founder: 'founder',
};

/**
 * Walks an approval request to `approved`, each step by the persona of its role (the founder step with a fresh ID
 * token, as in p3-exit). Returns the first non-2xx answer, or the last answer when every step passed.
 */
async function approveAll(requestId: string): Promise<Res> {
  const reader = await auth('founder');
  let last: Res = { status: 200, body: null };
  for (let guard = 0; guard < 8; guard += 1) {
    const got = await t
      .http()
      .get(`/v1/approvals/requests/${requestId}`)
      .set('authorization', reader);
    expect(got.status, show(got)).toBe(200);
    const request = ApprovalRequestDtoSchema.parse(got.body);
    if (request.status === 'approved') return last;
    if (request.status !== 'pending') return { status: 409, body: got.body as unknown };
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
    last = { status: res.status, body: res.body as unknown };
    if (res.status >= 300) return last;
  }
  throw new Error(`approval request ${requestId} did not reach approved`);
}

/** Creates a customer the way p3-exit does: a lead moved to qualified and converted. */
async function createCustomer(n: number): Promise<string> {
  const sales = await auth('sales');
  const created = await t
    .http()
    .post('/v1/leads')
    .set('authorization', sales)
    .send({
      title: `Model customer ${n}`,
      source: 'referral',
      companyName: `Model Customer ${n} Pvt. Ltd.`,
      contactName: `Buyer ${n}`,
      email: `buyer${n}@e2e-p3-model.test`,
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
        ...(stage === 'contacted' ? { contactActivity: { kind: 'call', body: 'Intro call' } } : {}),
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
        customer: { legalName: `Model Customer ${n} Pvt. Ltd.`, address: ADDRESS },
      },
      contact: {
        mode: 'create',
        contact: { fullName: `Buyer ${n}`, email: `buyer${n}@e2e-p3-model.test` },
      },
      opportunityName: `Model opportunity ${n}`,
      expectedVersion: lead.version,
    });
  expect(converted.status, show(converted)).toBe(201);
  return (converted.body as { customerId: string }).customerId;
}

// ------------------------------------------------------------------------------------------------ state (SQL)

interface InvoiceRow {
  id: string;
  kind: string;
  status: string;
  party: string;
  version: number;
  total: string;
  original: string | null;
  credited: string;
  open: string | null;
}
interface PaymentRow {
  id: string;
  status: string;
  party: string;
  version: number;
  submittedBy: string;
  unallocated: string | null;
}
interface AllocationRow {
  id: string;
  paymentId: string;
}
interface State {
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  allocations: AllocationRow[];
}

/** Creation order of every id the walk created: candidates are sorted by it, so a seed replays the same choices. */
const born = new Map<string, number>();
const remember = (id: string): void => {
  if (!born.has(id)) born.set(id, born.size);
};
const byBirth = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort(
    (a, b) =>
      (born.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (born.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );

async function readState(): Promise<State> {
  const scope = [world.scope.tenantId, world.scope.organizationId];
  const inv = await world.pool.query<InvoiceRow>(
    `SELECT i.id, i.kind, i.status, i.customer_party_id AS party, i.version, i.total::text AS total,
            i.original_invoice_id AS original,
            COALESCE((SELECT sum(cn.total) FROM app.invoices cn
                       WHERE cn.tenant_id = i.tenant_id AND cn.organization_id = i.organization_id
                         AND cn.original_invoice_id = i.id AND cn.kind = 'credit_note'
                         AND cn.status = 'issued'), 0)::text AS credited,
            (SELECT b.open_amount::text FROM app.open_item_balances b
              WHERE b.tenant_id = i.tenant_id AND b.organization_id = i.organization_id
                AND b.source_id = i.id AND b.source_type = i.kind) AS open
       FROM app.invoices i
      WHERE i.tenant_id = $1 AND i.organization_id = $2`,
    scope,
  );
  const pay = await world.pool.query<PaymentRow>(
    `SELECT p.id, p.status, p.customer_party_id AS party, p.version, p.submitted_by AS "submittedBy",
            (SELECT b.open_amount::text FROM app.open_item_balances b
              WHERE b.tenant_id = p.tenant_id AND b.organization_id = p.organization_id
                AND b.source_type = 'payment' AND b.source_id = p.id AND b.direction = 'credit') AS unallocated
       FROM app.payments p
      WHERE p.tenant_id = $1 AND p.organization_id = $2`,
    scope,
  );
  // Live forward allocations of verified payments against invoices: what a deallocation may name.
  const alloc = await world.pool.query<AllocationRow & { created: Date }>(
    `SELECT a.id, p.id AS "paymentId", a.created_at AS created
       FROM app.open_item_allocations a
       JOIN app.open_items c ON c.tenant_id = a.tenant_id AND c.id = a.credit_item_id
       JOIN app.open_items d ON d.tenant_id = a.tenant_id AND d.id = a.debit_item_id
       JOIN app.payments p ON p.tenant_id = c.tenant_id AND p.id = c.source_id
      WHERE a.tenant_id = $1 AND a.organization_id = $2
        AND c.source_type = 'payment' AND d.source_type IN ('tax_invoice', 'debit_note')
        AND a.reverses_allocation_id IS NULL AND p.status = 'verified'
        AND NOT EXISTS (SELECT 1 FROM app.open_item_allocations r
                         WHERE r.tenant_id = a.tenant_id AND r.reverses_allocation_id = a.id)`,
    scope,
  );
  const allocations = [...alloc.rows]
    .sort(
      (a, b) =>
        (born.get(a.paymentId) ?? 0) - (born.get(b.paymentId) ?? 0) ||
        a.created.getTime() - b.created.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map(({ id, paymentId }) => ({ id, paymentId }));
  return { invoices: byBirth(inv.rows), payments: byBirth(pay.rows), allocations };
}

/** Everything a refused command must leave as it was, as one canonical JSON text. */
async function snapshot(): Promise<string> {
  const { rows } = await world.pool.query<{ snap: string }>(
    `SELECT json_build_object(
       'invoices', (SELECT COALESCE(json_agg(json_build_array(id, status, version, number, total::text) ORDER BY id), '[]')
                      FROM app.invoices WHERE tenant_id = $1 AND organization_id = $2),
       'payments', (SELECT COALESCE(json_agg(json_build_array(id, status, version, number) ORDER BY id), '[]')
                      FROM app.payments WHERE tenant_id = $1 AND organization_id = $2),
       'proofs', (SELECT count(*) FROM app.payment_proofs WHERE tenant_id = $1 AND organization_id = $2),
       'items', (SELECT COALESCE(json_agg(json_build_array(id, amount::text) ORDER BY id), '[]')
                   FROM app.open_items WHERE tenant_id = $1 AND organization_id = $2),
       'allocations', (SELECT COALESCE(json_agg(json_build_array(id, amount::text) ORDER BY id), '[]')
                         FROM app.open_item_allocations WHERE tenant_id = $1 AND organization_id = $2),
       'events', (SELECT count(*) FROM app.posting_events WHERE tenant_id = $1 AND organization_id = $2),
       'approvals', (SELECT COALESCE(json_agg(json_build_array(id, status, version) ORDER BY id), '[]')
                       FROM app.approval_requests WHERE tenant_id = $1 AND organization_id = $2)
     )::text AS snap`,
    [world.scope.tenantId, world.scope.organizationId],
  );
  return rows[0]!.snap;
}

// ------------------------------------------------------------------------------------------------ invariants

interface PartyLedger {
  party: string;
  open_debits: string;
  open_credits: string;
  invoiced: string;
  debit_noted: string;
  credit_noted: string;
  settled: string;
  reversed: string;
}

/** Per customer, both sides of the ledger identity, each term derived by SQL. */
async function ledgerTerms(): Promise<PartyLedger[]> {
  const { rows } = await world.pool.query<PartyLedger>(
    `WITH p AS (SELECT unnest($3::uuid[]) AS party),
     ob AS (SELECT customer_party_id AS party,
                   sum(open_amount) FILTER (WHERE direction = 'debit') AS d,
                   sum(open_amount) FILTER (WHERE direction = 'credit') AS c
              FROM app.open_item_balances
             WHERE tenant_id = $1 AND organization_id = $2 AND side = 'receivable'
             GROUP BY customer_party_id),
     docs AS (SELECT customer_party_id AS party,
                     sum(total) FILTER (WHERE kind = 'tax_invoice') AS inv,
                     sum(total) FILTER (WHERE kind = 'debit_note') AS dn,
                     sum(total) FILTER (WHERE kind = 'credit_note') AS cn
                FROM app.invoices
               WHERE tenant_id = $1 AND organization_id = $2 AND status = 'issued'
               GROUP BY customer_party_id),
     pay AS (SELECT customer_party_id AS party,
                    sum(settles) FILTER (WHERE status IN ('verified', 'reversed')) AS settled,
                    sum(settles) FILTER (WHERE status = 'reversed') AS reversed
               FROM app.payments
              WHERE tenant_id = $1 AND organization_id = $2
              GROUP BY customer_party_id)
     SELECT p.party,
            COALESCE(ob.d, 0)::numeric(18, 2)::text AS open_debits,
            COALESCE(ob.c, 0)::numeric(18, 2)::text AS open_credits,
            COALESCE(docs.inv, 0)::numeric(18, 2)::text AS invoiced,
            COALESCE(docs.dn, 0)::numeric(18, 2)::text AS debit_noted,
            COALESCE(docs.cn, 0)::numeric(18, 2)::text AS credit_noted,
            COALESCE(pay.settled, 0)::numeric(18, 2)::text AS settled,
            COALESCE(pay.reversed, 0)::numeric(18, 2)::text AS reversed
       FROM p
       LEFT JOIN ob ON ob.party = p.party
       LEFT JOIN docs ON docs.party = p.party
       LEFT JOIN pay ON pay.party = p.party`,
    [world.scope.tenantId, world.scope.organizationId, customers],
  );
  return rows;
}

/**
 * Documents whose open items are wrong: an issued tax invoice / debit / credit note or a verified or reversed payment
 * without exactly one item of its amount, direction and customer; anything else (drafts, proformas, discarded,
 * submitted, rejected) with any item; a reversed payment whose credit is still open (the reversal must offset
 * it); or an item open outside [0, amount]. Empty when the ledger is right.
 */
async function openItemViolations(): Promise<unknown[]> {
  const { rows } = await world.pool.query(
    `SELECT 'invoice' AS what, i.id, i.kind, i.status, count(oi.id)::int AS items
       FROM app.invoices i
       LEFT JOIN app.open_items oi
         ON oi.tenant_id = i.tenant_id AND oi.organization_id = i.organization_id AND oi.source_id = i.id
      WHERE i.tenant_id = $1 AND i.organization_id = $2
      GROUP BY i.id
     HAVING NOT (
       CASE WHEN i.status = 'issued' AND i.kind IN ('tax_invoice', 'debit_note', 'credit_note')
            THEN count(oi.id) = 1
                 AND bool_and(oi.amount = i.total AND oi.source_type = i.kind
                              AND oi.side = 'receivable'
                              AND oi.customer_party_id = i.customer_party_id
                              AND oi.direction = CASE WHEN i.kind = 'credit_note' THEN 'credit' ELSE 'debit' END)
            ELSE count(oi.id) = 0 END)
     UNION ALL
     SELECT 'payment', p.id, NULL, p.status, count(oi.id)::int
       FROM app.payments p
       LEFT JOIN app.open_items oi
         ON oi.tenant_id = p.tenant_id AND oi.organization_id = p.organization_id
        AND oi.source_type = 'payment' AND oi.source_id = p.id
      WHERE p.tenant_id = $1 AND p.organization_id = $2
      GROUP BY p.id
     HAVING NOT (
       CASE WHEN p.status IN ('verified', 'reversed')
            THEN count(oi.id) = 1
                 AND bool_and(oi.amount = p.settles AND oi.direction = 'credit'
                              AND oi.customer_party_id = p.customer_party_id)
            ELSE count(oi.id) = 0 END)
     UNION ALL
     SELECT 'reversed payment still open', p.id, NULL, b.open_amount::text, NULL
       FROM app.payments p
       JOIN app.open_item_balances b
         ON b.tenant_id = p.tenant_id AND b.organization_id = p.organization_id
        AND b.source_type = 'payment' AND b.source_id = p.id AND b.direction = 'credit'
      WHERE p.tenant_id = $1 AND p.organization_id = $2 AND p.status = 'reversed'
        AND b.open_amount <> 0
     UNION ALL
     SELECT 'balance', b.open_item_id, b.source_type, b.open_amount::text, NULL
       FROM app.open_item_balances b
      WHERE b.tenant_id = $1 AND b.organization_id = $2
        AND (b.open_amount < 0 OR b.open_amount > b.amount)`,
    [world.scope.tenantId, world.scope.organizationId],
  );
  return rows as unknown[];
}

async function assertInvariants(where: string): Promise<void> {
  const terms = await ledgerTerms();
  expect(terms).toHaveLength(customers.length);
  for (const r of terms) {
    const left = new Decimal(r.open_debits).minus(r.open_credits);
    const right = new Decimal(r.invoiced)
      .plus(r.debit_noted)
      .minus(r.credit_noted)
      .minus(r.settled)
      .plus(r.reversed);
    expect(left.toFixed(2), `${where}: ledger identity of ${JSON.stringify(r)}`).toBe(
      right.toFixed(2),
    );
  }

  expect(await openItemViolations(), `${where}: open items`).toEqual([]);

  const res = await t
    .http()
    .get('/v1/receivables/aging')
    .set('authorization', await auth('finance'));
  expect(res.status, `${where}: aging ${show(res)}`).toBe(200);
  const aging = ArAgingReportSchema.parse(res.body);
  for (const r of terms) {
    const fromReport = aging.rows
      .filter((row) => row.customerId === r.party)
      .reduce((sum, row) => sum.plus(row.totalOpen), new Decimal(0));
    expect(fromReport.toFixed(2), `${where}: aging of ${r.party}`).toBe(
      new Decimal(r.open_debits).toFixed(2),
    );
  }
  const reportTotal = aging.totals.reduce((sum, x) => sum.plus(x.totalOpen), new Decimal(0));
  const ledgerTotal = terms.reduce((sum, r) => sum.plus(r.open_debits), new Decimal(0));
  expect(reportTotal.toFixed(2), `${where}: aging total`).toBe(ledgerTotal.toFixed(2));
}

// ------------------------------------------------------------------------------------------------ commands

type Expect = 'ok' | 'refuse' | 'either';
interface Command {
  name: string;
  expect: Expect;
  weight: number;
  /** Setup that is not part of the command (a seeded proof, a read); runs before the snapshot. */
  prepare?: () => Promise<void>;
  run: () => Promise<Res>;
}

const money = (lo: number, hi: number): string => `${int(lo, hi)}.00`;
const lineBody = () => ({
  description: `Service ${int(1, 99)}`,
  uom: 'job',
  quantity: new Decimal(int(1, 4)).toFixed(4),
  unitPrice: money(100, 20000),
  taxCodeId: vat13,
});
const lines = () => Array.from({ length: int(1, 2) }, lineBody);

function candidates(s: State): Command[] {
  const out: Command[] = [];
  const add = (c: Command) => {
    if (c.weight > 0) out.push(c);
  };
  const party = pick(customers);
  const issuedTax = s.invoices.filter((i) => i.kind === 'tax_invoice' && i.status === 'issued');

  add({
    name: `draft tax invoice for ${party}`,
    expect: 'ok',
    weight: 3,
    run: async () => {
      const res = await post('preparer', '/v1/invoices', {
        customerId: party,
        currency: 'NPR',
        manualReason: 'Model test: manual invoice',
        lines: lines(),
      });
      if (res.status === 201) remember(InvoiceDetailSchema.parse(res.body).invoice.id);
      return res;
    },
  });
  add({
    name: `draft proforma for ${party}`,
    expect: 'ok',
    weight: 1,
    run: async () => {
      const res = await post('preparer', '/v1/invoices/proforma', {
        customerId: party,
        currency: 'NPR',
        lines: lines(),
      });
      if (res.status === 201) remember(InvoiceDetailSchema.parse(res.body).invoice.id);
      return res;
    },
  });

  const approvable = (k: string) => k === 'tax_invoice' || k === 'credit_note';
  const drafts = s.invoices.filter((i) => approvable(i.kind) && i.status === 'draft');
  if (drafts.length > 0) {
    const inv = pick(drafts);
    add({
      name: `submit ${inv.kind} ${inv.id}`,
      expect: 'ok',
      weight: 3,
      run: () =>
        post(
          inv.kind === 'credit_note' ? 'finance2' : 'preparer',
          `/v1/invoices/${inv.id}/submit`,
          {
            expectedVersion: inv.version,
          },
        ),
    });
  }
  const submitted = s.invoices.filter((i) => approvable(i.kind) && i.status === 'submitted');
  if (submitted.length > 0) {
    const inv = pick(submitted);
    add({
      name: `approve ${inv.kind} ${inv.id}`,
      expect: 'ok',
      weight: 3,
      run: async () => {
        const { rows } = await world.pool.query<{ approval_request_id: string | null }>(
          'SELECT approval_request_id FROM app.invoices WHERE id = $1',
          [inv.id],
        );
        const requestId = rows[0]?.approval_request_id;
        expect(requestId, `submitted ${inv.id} has no approval request`).toBeTruthy();
        return approveAll(requestId!);
      },
    });
  }
  const approved = s.invoices.filter((i) => approvable(i.kind) && i.status === 'approved');
  if (approved.length > 0) {
    const inv = pick(approved);
    add({
      name: `issue ${inv.kind} ${inv.id}`,
      // A credit note may be refused at issue when other credits used up the original's room meanwhile.
      expect: inv.kind === 'credit_note' ? 'either' : 'ok',
      weight: 3,
      run: () => post('finance', `/v1/invoices/${inv.id}/issue`, { expectedVersion: inv.version }),
    });
  }
  const unapproved = s.invoices.filter(
    (i) => approvable(i.kind) && (i.status === 'draft' || i.status === 'submitted'),
  );
  if (unapproved.length > 0) {
    const inv = pick(unapproved);
    add({
      name: `WRONG: issue ${inv.status} ${inv.kind} ${inv.id}`,
      expect: 'refuse',
      weight: 1,
      run: () => post('finance', `/v1/invoices/${inv.id}/issue`, { expectedVersion: inv.version }),
    });
  }
  const proformaDrafts = s.invoices.filter((i) => i.kind === 'proforma' && i.status === 'draft');
  if (proformaDrafts.length > 0) {
    const inv = pick(proformaDrafts);
    add({
      name: `issue proforma ${inv.id}`,
      expect: 'ok',
      weight: 1,
      run: () => post('finance', `/v1/invoices/${inv.id}/issue`, { expectedVersion: inv.version }),
    });
  }

  // Credit notes: on an issued tax invoice that still has room (total less its issued credit notes).
  const withRoom = issuedTax.filter((i) => new Decimal(i.total).minus(i.credited).gt(0));
  if (withRoom.length > 0) {
    const inv = pick(withRoom);
    const fraction = pick(['0.1', '0.25', '0.5']);
    let body: unknown;
    add({
      name: `draft credit note (${fraction} of a line) on ${inv.id}`,
      // Pricing is the server's: the note may exceed the room left, which is a refusal, not a failure.
      expect: 'either',
      weight: 2,
      prepare: async () => {
        const res = await t
          .http()
          .get(`/v1/invoices/${inv.id}`)
          .set('authorization', await auth('finance2'));
        expect(res.status, show(res)).toBe(200);
        const line = pick(InvoiceDetailSchema.parse(res.body).lines);
        const quantity = new Decimal(line.quantity)
          .times(fraction)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        body = {
          originalInvoiceId: inv.id,
          reason: 'Model test: partial credit',
          lines: [
            {
              originalLineNo: line.lineNo,
              quantity: (quantity.gt(0) ? quantity : new Decimal('0.0001')).toFixed(4),
            },
          ],
        };
      },
      run: async () => {
        const res = await post('finance2', '/v1/credit-notes', body);
        if (res.status === 201) remember(InvoiceDetailSchema.parse(res.body).invoice.id);
        return res;
      },
    });
  }
  if (issuedTax.length > 0) {
    const inv = pick(issuedTax);
    add({
      name: `WRONG: oversized credit note on ${inv.id}`,
      expect: 'refuse',
      weight: 0.5,
      run: () =>
        post('finance2', '/v1/credit-notes', {
          originalInvoiceId: inv.id,
          reason: 'Model test: more than was invoiced',
          lines: [{ originalLineNo: 1, quantity: '999.0000' }],
        }),
    });
  }
  const taxDrafts = s.invoices.filter((i) => i.kind === 'tax_invoice' && i.status !== 'issued');
  if (taxDrafts.length > 0) {
    const inv = pick(taxDrafts);
    add({
      name: `WRONG: credit note on ${inv.status} invoice ${inv.id}`,
      expect: 'refuse',
      weight: 0.5,
      run: () =>
        post('finance2', '/v1/credit-notes', {
          originalInvoiceId: inv.id,
          reason: 'Model test: not issued',
          lines: [{ originalLineNo: 1, quantity: '1.0000' }],
        }),
    });
  }

  // Payments.
  for (const [recorder, weight] of [
    ['preparer', 3],
    ['finance2', 0.5],
  ] as const) {
    let proofId = '';
    const amount = money(500, 80000);
    add({
      name: `record payment ${amount} for ${party} by ${recorder}`,
      expect: 'ok',
      weight,
      prepare: async () => {
        proofId = await seedCleanProof(world, party, world.personas[recorder].userId);
      },
      run: async () => {
        const res = await post(recorder, '/v1/payments', {
          customerId: party,
          currency: 'NPR',
          amount,
          method: 'bank_transfer',
          receivedOn: kathmanduDay(),
          bankReference: `MODEL-${int(1000, 9999)}`,
          proofDocumentIds: [proofId],
        });
        if (res.status === 201) remember((res.body as { id: string }).id);
        return res;
      },
    });
  }
  const pending = s.payments.filter((p) => p.status === 'submitted');
  if (pending.length > 0) {
    const p = pick(pending);
    const self = p.submittedBy === world.personas.finance2.userId;
    add({
      name: `verify payment ${p.id}`,
      expect: 'ok',
      weight: 3,
      run: () =>
        post(self ? 'finance' : 'finance2', `/v1/payments/${p.id}/verify`, {
          expectedVersion: p.version,
        }),
    });
    add({
      name: `reject payment ${p.id}`,
      expect: 'ok',
      weight: 1,
      run: () =>
        post('finance', `/v1/payments/${p.id}/reject`, {
          expectedVersion: p.version,
          reason: 'Model test: slip does not match',
        }),
    });
    const own = pending.filter((x) => x.submittedBy === world.personas.finance2.userId);
    if (own.length > 0) {
      const o = pick(own);
      add({
        name: `WRONG: finance2 verifies own payment ${o.id}`,
        expect: 'refuse',
        weight: 1,
        run: () => post('finance2', `/v1/payments/${o.id}/verify`, { expectedVersion: o.version }),
      });
    }
    const target = issuedTax.find((i) => i.party === p.party);
    if (target !== undefined) {
      add({
        name: `WRONG: allocate unverified payment ${p.id}`,
        expect: 'refuse',
        weight: 0.5,
        run: () =>
          post('finance2', `/v1/payments/${p.id}/allocations`, {
            lines: [{ invoiceId: target.id, amount: '1.00' }],
          }),
      });
    }
  }
  const notPending = s.payments.filter((p) => p.status !== 'submitted');
  if (notPending.length > 0) {
    const p = pick(notPending);
    add({
      name: `WRONG: verify ${p.status} payment ${p.id}`,
      expect: 'refuse',
      weight: 0.5,
      run: () => post('finance2', `/v1/payments/${p.id}/verify`, { expectedVersion: p.version }),
    });
  }
  const notVerified = s.payments.filter((p) => p.status !== 'verified');
  if (notVerified.length > 0) {
    const p = pick(notVerified);
    add({
      name: `WRONG: reverse ${p.status} payment ${p.id}`,
      expect: 'refuse',
      weight: 0.5,
      run: () =>
        post('finance', `/v1/payments/${p.id}/reverse`, {
          expectedVersion: p.version,
          reason: 'Model test: not verified',
        }),
    });
  }
  const verified = s.payments.filter((p) => p.status === 'verified');
  if (verified.length > 0) {
    const p = pick(verified);
    add({
      name: `reverse payment ${p.id}`,
      expect: 'ok',
      weight: 1,
      run: () =>
        post('finance', `/v1/payments/${p.id}/reverse`, {
          expectedVersion: p.version,
          reason: 'Model test: cheque bounced',
        }),
    });
  }

  // Allocations: a verified payment with credit left, against an open issued invoice of the same customer.
  const pairs = verified.flatMap((p) =>
    issuedTax
      .filter((i) => i.party === p.party && new Decimal(i.open ?? '0').gt(0))
      .filter(() => new Decimal(p.unallocated ?? '0').gt(0))
      .map((i) => ({ p, i })),
  );
  if (pairs.length > 0) {
    const { p, i } = pick(pairs);
    const room = Decimal.min(p.unallocated ?? '0', i.open ?? '0');
    const amount =
      rand() < 0.3
        ? room
        : room.times(rand()).toDecimalPlaces(2, Decimal.ROUND_DOWN).clamp('0.01', room);
    add({
      name: `allocate ${amount.toFixed(2)} of ${p.id} to ${i.id}`,
      expect: 'ok',
      weight: 3,
      run: () =>
        post('finance2', `/v1/payments/${p.id}/allocations`, {
          lines: [{ invoiceId: i.id, amount: amount.toFixed(2) }],
        }),
    });
    add({
      name: `WRONG: over-allocate ${room.plus('0.01').toFixed(2)} of ${p.id} to ${i.id}`,
      expect: 'refuse',
      weight: 1,
      run: () =>
        post('finance2', `/v1/payments/${p.id}/allocations`, {
          lines: [{ invoiceId: i.id, amount: room.plus('0.01').toFixed(2) }],
        }),
    });
  }
  if (s.allocations.length > 0) {
    const a = pick(s.allocations);
    add({
      name: `deallocate ${a.id} of ${a.paymentId}`,
      expect: 'ok',
      weight: 1.5,
      run: () =>
        post('finance2', `/v1/payments/${a.paymentId}/allocations/${a.id}/reverse`, {
          reason: 'Model test: allocated to the wrong invoice',
        }),
    });
  }
  return out;
}

function choose(cs: Command[]): Command {
  const total = cs.reduce((sum, c) => sum + c.weight, 0);
  let r = rand() * total;
  for (const c of cs) {
    r -= c.weight;
    if (r < 0) return c;
  }
  return cs[cs.length - 1]!;
}

// ------------------------------------------------------------------------------------------------ the walk

describe('P3 model: a seeded walk of money commands keeps the receivables invariants', () => {
  it('0. the founder sets the entity address; two customers exist; VAT13 is seeded', async () => {
    const res = await t
      .http()
      .put('/v1/admin/settings/entity.address')
      .set('authorization', await auth('founder'))
      .send({ value: ADDRESS });
    expect([200, 204], show(res)).toContain(res.status);

    customers.push(await createCustomer(1), await createCustomer(2));

    const codes = await t
      .http()
      .get('/v1/tax-codes')
      .set('authorization', await auth('sales'));
    expect(codes.status, show(codes)).toBe(200);
    const codeList = (
      Array.isArray(codes.body) ? codes.body : (codes.body as { items: unknown[] }).items
    ) as { id: string; code: string }[];
    const found = codeList.find((c) => c.code === 'VAT13');
    expect(found, 'the production seed gives the tenant VAT13').toBeDefined();
    vat13 = found!.id;
    await assertInvariants('before the walk');
  });

  it(`1. ${STEPS} seeded commands; after each one the ledger identity, aging and open-item rules hold`, async () => {
    console.log(`[p3-model] seed=${SEED} steps=${STEPS} (replay: P3_MODEL_SEED=${SEED})`);
    const accepted = new Map<string, number>();
    let refused = 0;
    const kindOf = (name: string): string => {
      const words = name.split(' ');
      if (words[0] === 'WRONG:') return 'WRONG';
      if (words[0] === 'allocate' || words[0] === 'deallocate') return words[0];
      return words.slice(0, 2).join(' ');
    };

    for (let step = 1; step <= STEPS; step += 1) {
      const state = await readState();
      const command = choose(candidates(state));
      const where = `seed ${SEED} step ${step} "${command.name}"`;
      await command.prepare?.();
      const before = await snapshot();
      const res = await command.run();

      expect(res.status < 500, `${where}: server error ${show(res)}`).toBe(true);
      const ok = res.status < 300;
      if (command.expect === 'ok') expect(ok, `${where}: refused ${show(res)}`).toBe(true);
      if (command.expect === 'refuse') expect(ok, `${where}: accepted ${show(res)}`).toBe(false);
      if (ok) {
        const kind = kindOf(command.name);
        accepted.set(kind, (accepted.get(kind) ?? 0) + 1);
      } else {
        refused += 1;
        expect(await snapshot(), `${where}: a refused command changed state ${show(res)}`).toBe(
          before,
        );
      }
      await assertInvariants(where);
    }

    console.log(
      `[p3-model] accepted ${JSON.stringify(Object.fromEntries(accepted))}, refused ${refused}`,
    );
    // Coverage: a degenerate walk (nothing issued, no payment verified) proves nothing.
    if (STEPS >= 200) {
      for (const kind of [
        'draft tax',
        'submit tax_invoice',
        'approve tax_invoice',
        'issue tax_invoice',
        'record payment',
        'verify payment',
        'allocate',
      ]) {
        expect(accepted.get(kind) ?? 0, `seed ${SEED}: accepted "${kind}"`).toBeGreaterThanOrEqual(
          3,
        );
      }
      for (const kind of ['draft credit', 'issue credit_note', 'reverse payment', 'deallocate']) {
        expect(accepted.get(kind) ?? 0, `seed ${SEED}: accepted "${kind}"`).toBeGreaterThanOrEqual(
          1,
        );
      }
      expect(refused, `seed ${SEED}: refusals`).toBeGreaterThanOrEqual(15);
    }
  }, 600_000);
});
