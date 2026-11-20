// Integration test of PaymentsService on a real postgres:16-alpine (Testcontainers, needs Docker in WSL).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payments/payments.integration.test.ts
//
// Real: every migration as bos_owner, every query as bos_app (payments_guard, the payment CHECKs, the ledger
// triggers and the open_item_balances view), withTx, withIdempotency, NumberingService, MoneyService, AuditService
// and LedgerService. Stubbed: the request principal (authz.assert passes; route permissions are the controller's
// @Can) and the fx.max_rate_age_days setting (7, its default).
import { randomUUID } from 'node:crypto';

import {
  AllocationDtoSchema,
  PaymentDtoSchema,
  PaymentListItemSchema,
  RejectPaymentBodySchema,
  type SubmitPaymentBody,
} from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  documents,
  documentVersions,
  fxRates,
  openItems,
  postingEvents,
  runMigrations,
} from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
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
import { PAYMENT_INTAKE_OWNER_TYPE } from './payment-owner.policy';
import { PaymentsService, reversalSourceId } from './payments.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const NOW = new Date('2026-11-09T06:00:00Z');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let service: PaymentsService;
const ledger = new LedgerService();
const system = systemActor('payments-test');

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
  return {
    scope: { tenantId, organizationId },
    customer: customer.partyId,
    otherCustomer: otherCustomer.partyId,
    recorder: userActor(recorder.userId),
    verifier: userActor(verifier.userId),
  };
}

/** A proof uploaded for `customerId` before the payment exists, with one version of `status`. */
async function proof(
  w: World,
  customerId = w.customer,
  status: 'clean' | 'quarantined' = 'clean',
): Promise<string> {
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
      status,
      uploadedBy: w.recorder.id,
    });
  });
  return documentId;
}

async function submit(w: World, over: Partial<SubmitPaymentBody> = {}) {
  const body: SubmitPaymentBody = {
    customerId: w.customer,
    currency: 'NPR',
    amount: '600.00',
    tdsWithheld: '0.00',
    method: 'bank_transfer',
    receivedOn: '2026-11-08',
    proofDocumentIds: over.proofDocumentIds ?? [await proof(w)],
    ...over,
  };
  return service.submit(w.scope, w.recorder, body, 'staff', randomUUID());
}

/** An issued-invoice debit item of `amount` NPR (U6 writes these; seeded through LedgerService here). */
async function invoiceItem(w: World, amount: string): Promise<string> {
  return withTx(db, w.scope, system, async (tx) => {
    const { item } = await ledger.openItem(tx, w.scope, system, {
      side: 'receivable',
      direction: 'debit',
      partyId: w.customer,
      sourceType: 'tax_invoice',
      sourceId: randomUUID(),
      currency: 'NPR',
      amount,
      amountNpr: amount,
      fxRate: '1',
      documentDate: '2026-11-01',
    });
    return item.id;
  });
}

async function openAmount(w: World, itemId: string): Promise<string | undefined> {
  return withTx(db, w.scope, system, async (tx) =>
    (await ledger.openAmounts(tx, w.scope, [itemId])).get(itemId),
  );
}

async function itemsOf(w: World, sourceId: string) {
  return db
    .select()
    .from(openItems)
    .where(and(eq(openItems.tenantId, w.scope.tenantId), eq(openItems.sourceId, sourceId)));
}

async function eventsOf(
  w: World,
  sourceId: string,
  event: 'payment_verified' | 'payment_reversed',
) {
  return db
    .select()
    .from(postingEvents)
    .where(
      and(
        eq(postingEvents.tenantId, w.scope.tenantId),
        eq(postingEvents.sourceId, sourceId),
        eq(postingEvents.event, event),
      ),
    );
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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 12 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  const settings = { get: () => Promise.resolve(7) } as unknown as SettingsService;
  const authz = { assert: () => undefined } as unknown as AuthzService;
  service = new PaymentsService(
    db,
    authz,
    new MoneyService(db, settings),
    new NumberingService(),
    new AuditService(db),
    ledger,
    () => NOW,
  );
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('submit', () => {
  it('records a submitted payment with its proofs, no number and nothing on the ledger', async () => {
    const w = await newWorld();
    const doc = await proof(w);
    const p = await submit(w, { proofDocumentIds: [doc], tdsWithheld: '0.00' });
    expect(PaymentDtoSchema.parse(p)).toMatchObject({
      status: 'submitted',
      number: null,
      npr: null,
      submittedBy: w.recorder.id,
      submittedVia: 'staff',
      proofDocumentIds: [doc],
      unallocatedAmount: '0.00',
    });
    expect(await itemsOf(w, p.id)).toHaveLength(0);
  });

  it('refuses another customer’s proof and a proof already used (422 invalid_proof)', async () => {
    const w = await newWorld();
    const foreign = await proof(w, w.otherCustomer);
    await expect(submit(w, { proofDocumentIds: [foreign] })).rejects.toMatchObject({
      response: { code: 'invalid_proof' },
    });
    const doc = await proof(w);
    await submit(w, { proofDocumentIds: [doc] });
    await expect(submit(w, { proofDocumentIds: [doc] })).rejects.toMatchObject({
      response: { code: 'invalid_proof' },
    });
  });
});

describe('verify', () => {
  it('refuses the submitter with 403 self_verification and changes nothing', async () => {
    const w = await newWorld();
    const p = await submit(w);
    await expect(
      service.verify(w.scope, w.recorder, p.id, { expectedVersion: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 403, response: { code: 'self_verification' } });
    expect((await service.get(w.scope, p.id)).status).toBe('submitted');
    expect(await itemsOf(w, p.id)).toHaveLength(0);
  });

  it('the database refuses a verifier equal to the submitter too (payments_verifier_check)', async () => {
    const w = await newWorld();
    const p = await submit(w);
    await expect(
      withTx(db, w.scope, system, (tx) =>
        tx.execute(
          sql`UPDATE app.payments
              SET status = 'verified', verified_by = submitted_by, verified_at = now(),
                  fx_rate = 1, fx_source = 'NPR', fx_date = '2026-11-09',
                  amount_npr = amount, tds_npr = tds_withheld,
                  number = 'RCPT-2083/84-99999', seq = 99999, fiscal_year = '2083/84'
            WHERE id = ${p.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'payments_verifier_check' } });
  });

  it('opens exactly one credit item for amount + tds and one event; a replay returns the same answer', async () => {
    const w = await newWorld();
    const p = await submit(w, {
      amount: '600.00',
      tdsWithheld: '15.00',
      withholdingCode: undefined,
    });
    const key = randomUUID();
    const first = await service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, key);
    const replay = await service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, key);
    expect(replay).toEqual(first);
    expect(PaymentDtoSchema.parse(first)).toMatchObject({
      status: 'verified',
      verifiedBy: w.verifier.id,
      settles: '615.00',
      unallocatedAmount: '615.00',
      npr: { amountNpr: '600.00', rate: '1' },
    });
    expect(first.number).toMatch(/^RCPT-\d{4}\/\d{2}-00001$/);
    const items = await itemsOf(w, p.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      direction: 'credit',
      amount: '615.00',
      sourceType: 'payment',
    });
    expect(await eventsOf(w, p.id, 'payment_verified')).toHaveLength(1);
  });

  it('parallel verifies with different keys give one number, one item and one event', async () => {
    const w = await newWorld();
    const p = await submit(w);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, randomUUID()),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409 });
    }
    expect(await itemsOf(w, p.id)).toHaveLength(1);
    expect(await eventsOf(w, p.id, 'payment_verified')).toHaveLength(1);
  });

  it('leaves the invoice unpaid: verifying allocates nothing', async () => {
    const w = await newWorld();
    const invoice = await invoiceItem(w, '1000.00');
    const p = await submit(w);
    await service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, randomUUID());
    expect(await openAmount(w, invoice)).toBe('1000.00');
    expect(await service.allocations(w.scope, p.id)).toEqual([]);
  });

  it('refuses a USD rate older than 7 days with 409 fx_rate_stale', async () => {
    const w = await newWorld();
    await withTx(db, w.scope, w.recorder, (tx) =>
      tx.insert(fxRates).values({
        tenantId: w.scope.tenantId,
        currency: 'USD',
        rateNpr: '133.500000',
        source: 'manual',
        rateDate: '2026-11-01',
      }),
    );
    const p = await submit(w, { currency: 'USD', amount: '10.00' });
    await expect(
      service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 409, response: { code: 'fx_rate_stale' } });
    expect(await itemsOf(w, p.id)).toHaveLength(0);
  });

  it('refuses a proof that has not passed the scan (409 proof_not_clean)', async () => {
    const w = await newWorld();
    const p = await submit(w);
    // A clean version is frozen, so the bad file arrives as a newer version that the scan found infected.
    const versionId = randomUUID();
    await withTx(db, w.scope, w.recorder, (tx) =>
      tx.insert(documentVersions).values({
        id: versionId,
        tenantId: w.scope.tenantId,
        organizationId: w.scope.organizationId,
        documentId: p.proofDocumentIds[0] ?? '',
        version: 2,
        filename: 'slip-2.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 1000,
        storageKey: `${w.scope.tenantId}/${versionId}`,
        status: 'infected',
        uploadedBy: w.recorder.id,
      }),
    );
    await expect(
      service.verify(w.scope, w.verifier, p.id, { expectedVersion: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 409, response: { code: 'proof_not_clean' } });
  });
});

describe('reject and withdraw', () => {
  it('reject needs a reason', async () => {
    const w = await newWorld();
    const p = await submit(w);
    expect(RejectPaymentBodySchema.safeParse({ expectedVersion: 1, reason: '  ' }).success).toBe(
      false,
    );
    await expect(
      service.reject(w.scope, w.verifier, p.id, { expectedVersion: 1, reason: ' ' }, randomUUID()),
    ).rejects.toMatchObject({ status: 422, response: { code: 'reason_required' } });
    const rejected = await service.reject(
      w.scope,
      w.verifier,
      p.id,
      { expectedVersion: 1, reason: 'Slip is for another account' },
      randomUUID(),
    );
    expect(PaymentDtoSchema.parse(rejected)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Slip is for another account',
      number: null,
    });
    expect(await itemsOf(w, p.id)).toHaveLength(0);
  });

  it('only the submitter may withdraw, and only while submitted', async () => {
    const w = await newWorld();
    const p = await submit(w);
    await expect(
      service.withdraw(w.scope, w.verifier, p.id, { expectedVersion: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
    const withdrawn = await service.withdraw(
      w.scope,
      w.recorder,
      p.id,
      { expectedVersion: 1 },
      randomUUID(),
    );
    expect(withdrawn.status).toBe('withdrawn');
    await expect(
      service.verify(w.scope, w.verifier, p.id, { expectedVersion: 2 }, randomUUID()),
    ).rejects.toMatchObject({ status: 409, response: { code: 'payment_not_submitted' } });
  });
});

describe('reverseVerified', () => {
  it('reverses the allocations and nets the credit item with an auto-allocated debit item', async () => {
    const w = await newWorld();
    const invoice = await invoiceItem(w, '1000.00');
    const p = await submit(w, { amount: '600.00' });
    const verified = await service.verify(
      w.scope,
      w.verifier,
      p.id,
      { expectedVersion: 1 },
      randomUUID(),
    );
    const [credit] = await itemsOf(w, p.id);
    if (credit === undefined) throw new Error('no credit item');
    // U8 allocates; seeded through LedgerService here.
    await withTx(db, w.scope, w.verifier, (tx) =>
      ledger.allocate(tx, w.scope, w.verifier, {
        debitItemId: invoice,
        creditItemId: credit.id,
        amount: '600.00',
      }),
    );
    expect(await openAmount(w, invoice)).toBe('400.00');

    const key = randomUUID();
    const body = { expectedVersion: verified.version, reason: 'Cheque bounced' };
    const reversed = await service.reverseVerified(w.scope, w.verifier, p.id, body, key);
    const replay = await service.reverseVerified(w.scope, w.verifier, p.id, body, key);
    expect(replay).toEqual(reversed);
    expect(PaymentDtoSchema.parse(reversed)).toMatchObject({
      status: 'reversed',
      number: verified.number,
      unallocatedAmount: '0.00',
    });
    expect(await openAmount(w, invoice)).toBe('1000.00');
    expect(await openAmount(w, credit.id)).toBe('0.00');
    const [debit] = await itemsOf(w, reversalSourceId(p.id));
    expect(debit).toMatchObject({ direction: 'debit', amount: '600.00', sourceType: 'payment' });
    expect(await openAmount(w, debit?.id ?? '')).toBe('0.00');
    expect(await eventsOf(w, p.id, 'payment_reversed')).toHaveLength(1);

    const rows = z.array(AllocationDtoSchema).parse(await service.allocations(w.scope, p.id));
    expect(rows.map((r) => r.amount)).toEqual(['600.00', '-600.00']);
    expect(rows[1]).toMatchObject({ reversesAllocationId: rows[0]?.id, reason: 'Cheque bounced' });
  });

  it('refuses a payment that is not verified', async () => {
    const w = await newWorld();
    const p = await submit(w);
    await expect(
      service.reverseVerified(
        w.scope,
        w.verifier,
        p.id,
        { expectedVersion: 1, reason: 'x' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: 'payment_not_verified' } });
  });
});

describe('one legal entity at a time', () => {
  it('answers 404 for a payment of another entity of the same tenant', async () => {
    const w = await newWorld();
    const p = await submit(w);
    const otherEntity = randomUUID();
    const other: TxScope = { tenantId: w.scope.tenantId, organizationId: otherEntity };
    await withTx(db, other, system, (tx) =>
      tx.execute(
        sql`INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
            VALUES (${otherEntity}, ${w.scope.tenantId}, ${otherEntity}, ${`X${otherEntity.slice(0, 6)}`}, 'Other', 'Other', false)`,
      ),
    );
    await expect(service.get(other, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.allocations(other, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.verify(other, w.verifier, p.id, { expectedVersion: 1 }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.list(other)).toEqual({ rows: [], total: 0, totals: [] });
    // Filters and a search narrow the entity; they never reach another entity's payment.
    expect(
      (await service.list(other, { status: ['submitted'], q: p.number ?? 'RCPT' })).total,
    ).toBe(0);
    expect((await service.summary(other)).total).toBe(0);
    const { rows, total, totals } = await service.list(w.scope);
    const listed = z.array(PaymentListItemSchema).parse(rows);
    expect(listed.map((r) => r.id)).toEqual([p.id]);
    expect(total).toBe(1);
    // The money received per currency (U15b-Q4): a submitted payment is a row but not yet money, so it adds
    // nothing; a filter that matches nothing totals nothing.
    expect(totals).toEqual([{ currency: p.currency, amount: '0.00' }]);
    expect((await service.list(w.scope, { status: ['verified'] })).totals).toEqual([]);
    expect((await service.list(w.scope, { status: ['verified'] })).total).toBe(0);
    expect((await service.list(w.scope, { method: [p.method], status: ['submitted'] })).total).toBe(
      1,
    );
    expect((await service.list(w.scope, { limit: 1, offset: 1 })).rows).toEqual([]);
    const summary = await service.summary(w.scope);
    expect(summary.total).toBe(1);
    expect(summary.byStatus.submitted).toBe(1);
  });
});
