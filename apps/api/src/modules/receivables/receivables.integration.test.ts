// Integration test of AllocationsService and ReceivablesService on a real postgres:16-alpine (Testcontainers, needs
// Docker in WSL). Run with:
//   pnpm --filter @bos/api exec vitest run src/modules/receivables/receivables.integration.test.ts
//
// Real: every migration as bos_owner, every query as bos_app (the invoice guards, the ledger triggers and the
// open_item_balances view), withTx, withIdempotency, LedgerService, AuditService, and PaymentsService (U7) to submit
// and verify payments. Stubbed: the request principal (authz.assert passes; route permissions are the controllers'
// @Can) and the fx.max_rate_age_days setting. Issued invoices are seeded the way U6 will issue them: a draft row
// moved to issued in one UPDATE, plus its debit open item through LedgerService.
import { randomUUID } from 'node:crypto';

import {
  AllocationDtoSchema,
  ArAgingReportSchema,
  CustomerAdvanceSchema,
  InvoiceSettlementSchema,
} from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  documents,
  documentVersions,
  runMigrations,
} from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { type Db } from '../../platform/db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../../platform/db/tx';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import type { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import { PAYMENT_INTAKE_OWNER_TYPE } from '../payments/payment-owner.policy';
import { PaymentsService } from '../payments/payments.service';
import { AllocationsService } from './allocations.service';
import { ReceivablesService } from './receivables.service';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
/** 11:45 in Kathmandu on 2026-11-09; seeded invoices are issued 2026-11-01 and due 2026-12-01. */
const NOW = new Date('2026-11-09T06:00:00Z');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let payments: PaymentsService;
let allocations: AllocationsService;
let receivables: ReceivablesService;
const ledger = new LedgerService();
const system = systemActor('receivables-test');
let nextSeq = 1;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function userActor(id: string): Actor {
  return { kind: 'user', id, correlationId: `test-${randomUUID()}` };
}

interface World {
  scope: TxScope;
  customer: string;
  otherCustomer: string;
  recorder: Actor;
  verifier: Actor;
}

async function newWorld(): Promise<World> {
  const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(appPool);
  const customer = await createParty(appPool, { tenantId, kind: 'customer' });
  const otherCustomer = await createParty(appPool, { tenantId, kind: 'customer' });
  const recorder = await createStaffUser(appPool, { tenantId, organizationId, idpOrgId });
  const verifier = await createStaffUser(appPool, { tenantId, organizationId, idpOrgId });
  // invoices.customer_party_id references app.customers (the CRM record behind the party).
  const address = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });
  for (const partyId of [customer.partyId, otherCustomer.partyId]) {
    await withTx(db, { tenantId, organizationId }, system, (tx) =>
      tx.execute(
        sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
            VALUES (${partyId}, ${tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', ${`acme-${partyId}`},
                    ${address}::jsonb)`,
      ),
    );
  }
  return {
    scope: { tenantId, organizationId },
    customer: customer.partyId,
    otherCustomer: otherCustomer.partyId,
    recorder: userActor(recorder.userId),
    verifier: userActor(verifier.userId),
  };
}

/** A second legal entity of the same tenant. */
async function otherEntity(w: World): Promise<TxScope> {
  const id = randomUUID();
  const other: TxScope = { tenantId: w.scope.tenantId, organizationId: id };
  await withTx(db, other, system, (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
          VALUES (${id}, ${w.scope.tenantId}, ${id}, ${`X${id.slice(0, 6)}`}, 'Other', 'Other', false)`,
    ),
  );
  return other;
}

/**
 * An issued invoice of `kind` for `customer` with total `total` NPR (no discount, no tax). A tax invoice or debit note
 * also gets its debit open item, as U6's issue writes it; a proforma gets none (A12).
 */
async function issuedInvoice(
  scope: TxScope,
  customer: string,
  total: string,
  kind: 'tax_invoice' | 'proforma' | 'debit_note' = 'tax_invoice',
  original?: string,
): Promise<string> {
  return withTx(db, scope, system, async (tx) => {
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.invoices
            (tenant_id, organization_id, kind, customer_party_id, original_invoice_id, manual_reason, note_reason,
             currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${kind}, ${customer}, ${original ?? null},
                  ${kind === 'tax_invoice' ? 'One-off sale' : null},
                  ${kind === 'debit_note' ? 'Price correction' : null},
                  'NPR', ${total}, 0, ${total}, 0, ${total})
          RETURNING id`,
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('invoice insert returned no row');
    const seq = nextSeq++;
    const prefix = kind === 'proforma' ? 'PI' : kind === 'debit_note' ? 'DN' : 'INV';
    await tx.execute(
      sql`UPDATE app.invoices
             SET status = 'issued', number = ${`${prefix}-2083/84-${String(seq).padStart(5, '0')}`}, seq = ${seq},
                 fiscal_year = '2083/84', issue_date = '2026-11-01', issue_date_bs = '2083-07-15',
                 due_date = '2026-12-01', fx_rate = 1, amount_npr = total,
                 seller_snapshot = '{"name": "Techrida Pvt. Ltd."}', buyer_snapshot = '{"name": "Acme"}',
                 content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now()
           WHERE id = ${id}`,
    );
    if (kind !== 'proforma') {
      await ledger.openItem(tx, scope, system, {
        side: 'receivable',
        direction: 'debit',
        partyId: customer,
        sourceType: kind,
        sourceId: id,
        currency: 'NPR',
        amount: total,
        amountNpr: total,
        fxRate: '1',
        documentDate: '2026-11-01',
        dueDate: '2026-12-01',
      });
    }
    return id;
  });
}

async function proof(w: World, customerId: string): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await withTx(db, w.scope, w.recorder, async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      tenantId: w.scope.tenantId,
      organizationId: w.scope.organizationId,
      ownerType: PAYMENT_INTAKE_OWNER_TYPE,
      ownerId: customerId,
      createdBy: w.recorder.id,
    });
    await tx.insert(documentVersions).values({
      id: versionId,
      tenantId: w.scope.tenantId,
      organizationId: w.scope.organizationId,
      documentId,
      version: 1,
      filename: 'slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 1000,
      storageKey: `${w.scope.tenantId}/${versionId}`,
      status: 'clean',
      uploadedBy: w.recorder.id,
    });
  });
  return documentId;
}

async function submitted(w: World, amount: string, customerId = w.customer): Promise<string> {
  const p = await payments.submit(
    w.scope,
    w.recorder,
    {
      customerId,
      currency: 'NPR',
      amount,
      tdsWithheld: '0.00',
      method: 'bank_transfer',
      receivedOn: '2026-11-08',
      proofDocumentIds: [await proof(w, customerId)],
    },
    'staff',
    randomUUID(),
  );
  return p.id;
}

/** A verified NPR payment of `amount`: one credit open item, nothing allocated. */
async function verified(w: World, amount: string, customerId = w.customer): Promise<string> {
  const id = await submitted(w, amount, customerId);
  await payments.verify(w.scope, w.verifier, id, { expectedVersion: 1 }, randomUUID());
  return id;
}

function allocate(
  w: World,
  paymentId: string,
  lines: { invoiceId: string; amount: string }[],
  key = randomUUID(),
) {
  return allocations.allocate(w.scope, w.verifier, paymentId, { lines }, key);
}

async function statementOf(w: World, invoiceId: string) {
  const rows = z
    .array(InvoiceSettlementSchema)
    .parse(await receivables.statement(w.scope, w.customer, {}));
  const row = rows.find((r) => r.invoiceId === invoiceId);
  if (row === undefined) throw new Error(`invoice ${invoiceId} is not on the statement`);
  return row;
}

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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 14 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  const settings = { get: () => Promise.resolve(7) } as unknown as SettingsService;
  const authz = { assert: () => undefined } as unknown as AuthzService;
  const audit = new AuditService(db);
  payments = new PaymentsService(
    db,
    authz,
    new MoneyService(db, settings),
    new NumberingService(),
    audit,
    ledger,
    () => NOW,
  );
  allocations = new AllocationsService(db, authz, audit, ledger);
  receivables = new ReceivablesService(db, authz, () => NOW);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('paid is derived (check 8)', () => {
  it('verifying a payment alone leaves the invoice unpaid and the credit shows as an advance', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    await verified(w, '600.00');
    expect(await statementOf(w, invoice)).toMatchObject({
      kind: 'tax_invoice',
      issueDate: '2026-11-01',
      total: '1000.00',
      allocatedAmount: '0.00',
      openAmount: '1000.00',
      daysOverdue: 0,
      settlement: 'unpaid',
    });
    const advance = z
      .array(CustomerAdvanceSchema)
      .parse(await receivables.advance(w.scope, w.customer));
    expect(advance).toEqual([{ customerId: w.customer, currency: 'NPR', amount: '600.00' }]);
  });

  it('allocating and deallocating flips the derived settlement', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const first = await verified(w, '600.00');
    const second = await verified(w, '400.00');

    const [a1] = z
      .array(AllocationDtoSchema)
      .parse(await allocate(w, first, [{ invoiceId: invoice, amount: '600.00' }]));
    expect(a1).toMatchObject({
      invoiceId: invoice,
      paymentId: first,
      creditNoteId: null,
      amount: '600.00',
      reversesAllocationId: null,
      createdBy: w.verifier.id,
    });
    expect(await statementOf(w, invoice)).toMatchObject({
      allocatedAmount: '600.00',
      openAmount: '400.00',
      settlement: 'partly_paid',
    });
    await allocate(w, second, [{ invoiceId: invoice, amount: '400.00' }]);
    expect(await statementOf(w, invoice)).toMatchObject({ openAmount: '0.00', settlement: 'paid' });
    expect(await receivables.statement(w.scope, w.customer, { open: true })).toEqual([]);
    expect(await receivables.advance(w.scope, w.customer)).toEqual([]);

    const reversal = AllocationDtoSchema.parse(
      await allocations.reverse(
        w.scope,
        w.verifier,
        first,
        a1!.id,
        { reason: 'Wrong invoice' },
        randomUUID(),
      ),
    );
    expect(reversal).toMatchObject({
      invoiceId: invoice,
      paymentId: first,
      amount: '-600.00',
      reversesAllocationId: a1!.id,
      reason: 'Wrong invoice',
      createdBy: w.verifier.id,
    });
    expect(await statementOf(w, invoice)).toMatchObject({
      allocatedAmount: '400.00',
      openAmount: '600.00',
      settlement: 'partly_paid',
    });
    expect(await receivables.advance(w.scope, w.customer)).toEqual([
      { customerId: w.customer, currency: 'NPR', amount: '600.00' },
    ]);
    // U7's read sees the forward row and its reversal.
    expect((await payments.allocations(w.scope, first)).map((a) => a.amount)).toEqual([
      '600.00',
      '-600.00',
    ]);
  });

  it('replays an allocation with the same Idempotency-Key instead of allocating twice', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const p = await verified(w, '300.00');
    const key = randomUUID();
    const once = await allocate(w, p, [{ invoiceId: invoice, amount: '300.00' }], key);
    const again = await allocate(w, p, [{ invoiceId: invoice, amount: '300.00' }], key);
    expect(again).toEqual(once);
    expect((await statementOf(w, invoice)).openAmount).toBe('700.00');
  });
});

describe('allocation refusals', () => {
  it('10 parallel 30% allocations never exceed the total; the extras get OVER_ALLOCATION (check 5)', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await verified(w, '300.00'));
    const results = await Promise.allSettled(
      ids.map((id) => allocate(w, id, [{ invoiceId: invoice, amount: '300.00' }])),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r.reason).toMatchObject({ status: 409, response: { code: 'OVER_ALLOCATION' } });
    }
    expect(await statementOf(w, invoice)).toMatchObject({
      allocatedAmount: '900.00',
      openAmount: '100.00',
      settlement: 'partly_paid',
    });
  });

  it('refuses more than the payment can settle, across lines (OVER_ALLOCATION)', async () => {
    const w = await newWorld();
    const a = await issuedInvoice(w.scope, w.customer, '500.00');
    const b = await issuedInvoice(w.scope, w.customer, '500.00');
    const p = await verified(w, '600.00');
    await expect(
      allocate(w, p, [
        { invoiceId: a, amount: '400.00' },
        { invoiceId: b, amount: '300.00' },
      ]),
    ).rejects.toMatchObject({ status: 409, response: { code: 'OVER_ALLOCATION' } });
    await expect(allocate(w, p, [{ invoiceId: a, amount: '500.01' }])).rejects.toMatchObject({
      status: 409,
      response: { code: 'OVER_ALLOCATION' },
    });
    expect((await statementOf(w, a)).openAmount).toBe('500.00');
  });

  it('never allocates to a proforma (G5 at runtime), another customer’s invoice, or from an unverified payment', async () => {
    const w = await newWorld();
    const proforma = await issuedInvoice(w.scope, w.customer, '1000.00', 'proforma');
    const foreign = await issuedInvoice(w.scope, w.otherCustomer, '1000.00');
    const p = await verified(w, '600.00');
    await expect(allocate(w, p, [{ invoiceId: proforma, amount: '100.00' }])).rejects.toMatchObject(
      {
        status: 409,
        response: { code: 'MISMATCHED_ITEMS' },
      },
    );
    await expect(allocate(w, p, [{ invoiceId: foreign, amount: '100.00' }])).rejects.toMatchObject({
      status: 409,
      response: { code: 'MISMATCHED_ITEMS' },
    });
    const pending = await submitted(w, '100.00');
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    await expect(
      allocate(w, pending, [{ invoiceId: invoice, amount: '100.00' }]),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'payment_not_verified' },
    });
    expect(await payments.allocations(w.scope, p)).toEqual([]);
  });

  it('allocates to an issued debit note', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const note = await issuedInvoice(w.scope, w.customer, '200.00', 'debit_note', invoice);
    const p = await verified(w, '200.00');
    await allocate(w, p, [{ invoiceId: note, amount: '200.00' }]);
    expect(await statementOf(w, note)).toMatchObject({ kind: 'debit_note', settlement: 'paid' });
  });

  it('refuses a system actor (403): created_by must be a user', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const p = await verified(w, '100.00');
    await expect(
      allocations.allocate(
        w.scope,
        system,
        p,
        { lines: [{ invoiceId: invoice, amount: '100.00' }] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('aging', () => {
  it('totals equal the sum of open receivable debits, per currency, as of Kathmandu today', async () => {
    const w = await newWorld();
    const a = await issuedInvoice(w.scope, w.customer, '1000.00');
    await issuedInvoice(w.scope, w.otherCustomer, '250.00');
    const p = await verified(w, '400.00');
    await allocate(w, p, [{ invoiceId: a, amount: '400.00' }]);
    const report = ArAgingReportSchema.parse(await receivables.aging(w.scope));
    expect(report.asOf).toBe('2026-11-09');
    const sum = await withTx(db, w.scope, system, (tx) =>
      tx.execute<{ total: string }>(
        sql`SELECT COALESCE(sum(open_amount), 0)::numeric(18, 2)::text AS total FROM app.open_item_balances
             WHERE tenant_id = ${w.scope.tenantId} AND organization_id = ${w.scope.organizationId}
               AND side = 'receivable' AND direction = 'debit' AND open_amount > 0`,
      ),
    );
    expect(report.totals).toEqual([
      {
        currency: 'NPR',
        buckets: {
          current: '850.00',
          d1_30: '0.00',
          d31_60: '0.00',
          d61_90: '0.00',
          d91_plus: '0.00',
        },
        totalOpen: sum.rows[0]?.total,
      },
    ]);
    expect(sum.rows[0]?.total).toBe('850.00');
    expect(report.rows.map((r) => [r.customerId, r.totalOpen]).sort()).toEqual(
      [
        [w.customer, '600.00'],
        [w.otherCustomer, '250.00'],
      ].sort(),
    );
  });
});

describe('one legal entity at a time', () => {
  it('answers 404 for another entity’s payment, invoice and allocation, and shows it nothing', async () => {
    const w = await newWorld();
    const other = await otherEntity(w);
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const p = await verified(w, '500.00');
    const [a] = await allocate(w, p, [{ invoiceId: invoice, amount: '100.00' }]);
    const foreignInvoice = await issuedInvoice(other, w.customer, '1000.00');

    await expect(
      allocations.allocate(
        other,
        w.verifier,
        p,
        { lines: [{ invoiceId: foreignInvoice, amount: '1.00' }] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      allocate(w, p, [{ invoiceId: foreignInvoice, amount: '1.00' }]),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      allocations.reverse(other, w.verifier, p, a!.id, { reason: 'x' }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    expect((await receivables.statement(other, w.customer, {})).map((r) => r.invoiceId)).toEqual([
      foreignInvoice,
    ]);
    expect(await receivables.advance(other, w.customer)).toEqual([]);
    const otherAging = await receivables.aging(other);
    expect(otherAging.totals.map((t) => t.totalOpen)).toEqual(['1000.00']);
    await expect(receivables.statement(w.scope, randomUUID(), {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('answers 404 for an allocation that is not this payment’s', async () => {
    const w = await newWorld();
    const invoice = await issuedInvoice(w.scope, w.customer, '1000.00');
    const p1 = await verified(w, '100.00');
    const p2 = await verified(w, '100.00');
    const [a] = await allocate(w, p1, [{ invoiceId: invoice, amount: '100.00' }]);
    await expect(
      allocations.reverse(w.scope, w.verifier, p2, a!.id, { reason: 'x' }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
  });
});
