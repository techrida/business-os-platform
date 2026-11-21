// Integration tests for 0022_payments (P3 unit U2) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/payments.test.ts
//
// What 0022 must hold, written as bos_app (the API's role) unless a case says otherwise:
//   * the migrations apply, and checkTenancy() (strict) and checkAudit() find nothing;
//   * settles is computed (amount + tds_withheld), and a submitted payment has no number;
//   * nobody verifies their own payment, and a rejection needs a reason;
//   * a number exists exactly when the payment is verified or reversed, and a verified one has its NPR snapshot;
//   * the customer is a customer party, the TDS code a withholding code of the same tenant;
//   * a proof links a payment to a document of the same entity only, and proofs are append-only;
//   * the lifecycle: submitted -> verified | rejected | withdrawn, verified -> reversed, content frozen after that,
//     and bos_app cannot DELETE a payment.
//
// Setup mirrors ledger.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app, with the acting entity set per transaction like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createStaffUser, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
  idpOrgId: string;
  customerId: string;
  /** Two staff users: the one who submits and the one who verifies. */
  submitter: string;
  verifier: string;
}

/** Runs fn in one transaction as bos_app, with `organizationId` as the acting entity (like withTx). */
async function inTx<T>(organizationId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('bos.organization_id', $1, true)`, [organizationId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** One statement in `organizationId`'s entity; returns the first row. */
async function run<T extends object = { id: string }>(
  organizationId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return inTx(organizationId, async (c) => {
    const { rows } = await c.query<T>(sql, params);
    return rows[0] as T;
  });
}

async function newScope(): Promise<Scope> {
  const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(app);
  const { partyId: customerId } = await createParty(app, { tenantId, kind: 'customer' });
  const staff = { tenantId, organizationId, idpOrgId };
  const { userId: submitter } = await createStaffUser(app, staff);
  const { userId: verifier } = await createStaffUser(app, staff);
  return { tenantId, organizationId, idpOrgId, customerId, submitter, verifier };
}

/** A second legal entity of the same tenant. */
async function insertEntity(tenantId: string): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, false)`,
    [id, tenantId, `E-${id}`],
  );
  return id;
}

interface PaymentInput {
  customerPartyId?: string;
  status?: string;
  method?: string;
  currency?: 'NPR' | 'USD';
  amount?: string;
  tds?: string;
  withholdingCodeId?: string | null;
  number?: string | null;
  seq?: number | null;
  fiscalYear?: string | null;
  rejectionReason?: string | null;
}

/** A submitted (by default) NPR payment of 1,000.00 by `scope.submitter`; every column can be overridden. */
async function insertPayment(scope: Scope, input: PaymentInput = {}): Promise<string> {
  const row = await run(
    scope.organizationId,
    `INSERT INTO app.payments
       (tenant_id, organization_id, customer_party_id, status, method, currency, amount, tds_withheld,
        withholding_code_id, received_on, bank_reference, submitted_by, channel, number, seq, fiscal_year,
        rejection_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-11-09', 'TXN-1', $10, 'staff', $11, $12, $13, $14)
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      input.customerPartyId ?? scope.customerId,
      input.status ?? 'submitted',
      input.method ?? 'bank_transfer',
      input.currency ?? 'NPR',
      input.amount ?? '1000.00',
      input.tds ?? '0',
      input.withholdingCodeId ?? null,
      scope.submitter,
      input.number ?? null,
      input.seq ?? null,
      input.fiscalYear ?? null,
      input.rejectionReason ?? null,
    ],
  );
  return row.id;
}

let receiptSeq = 0;

/** The update a verification makes: verifier, time, receipt number and the (NPR) snapshot. */
function verify(scope: Scope, id: string, verifiedBy = scope.verifier): Promise<unknown> {
  receiptSeq += 1;
  return run(
    scope.organizationId,
    `UPDATE app.payments
        SET status = 'verified', verified_by = $2, verified_at = now(), number = $3, seq = $4,
            fiscal_year = '2083/84', fx_rate = 1, amount_npr = amount, tds_npr = tds_withheld,
            version = version + 1
      WHERE id = $1 RETURNING id`,
    [id, verifiedBy, `RCPT-2083/84-${String(receiptSeq).padStart(5, '0')}`, receiptSeq],
  );
}

async function setStatus(scope: Scope, id: string, status: string): Promise<unknown> {
  return run(
    scope.organizationId,
    'UPDATE app.payments SET status = $2 WHERE id = $1 RETURNING id',
    [id, status],
  );
}

async function insertDocument(organizationId: string, tenantId: string): Promise<string> {
  const row = await run(
    organizationId,
    `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
     VALUES ($1, $2, 'payment', $3) RETURNING id`,
    [tenantId, organizationId, randomUUID()],
  );
  return row.id;
}

function insertProof(scope: Scope, paymentId: string, documentId: string): Promise<unknown> {
  return run(
    scope.organizationId,
    `INSERT INTO app.payment_proofs (tenant_id, organization_id, payment_id, document_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [scope.tenantId, scope.organizationId, paymentId, documentId],
  );
}

const CHECK = (constraint: string) => ({ code: '23514', constraint });
const FK = (constraint: string) => ({ code: '23503', constraint });

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:payments-test'],
    ['bos.correlation_id', 'payments-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('0022_payments on a fresh database', () => {
  it('applies, and creates both tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [['payments', 'payment_proofs']],
    );
    expect(rows.filter((r) => r.oid === null).map((r) => r.name)).toEqual([]);
  });

  it('passes checkTenancy() with the strict defaults', async () => {
    const violations = await checkTenancy(owner);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('passes checkAudit()', async () => {
    await expect(checkAudit(owner)).resolves.toEqual([]);
  });
});

describe('settles', () => {
  it('is computed as amount + tds_withheld, in the document currency and in NPR', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope, { amount: '1000.00', tds: '150.50' });
    const before = await run<{ settles: string; settles_npr: string | null }>(
      scope.organizationId,
      'SELECT settles, settles_npr FROM app.payments WHERE id = $1',
      [id],
    );
    expect(before).toEqual({ settles: '1150.50', settles_npr: null });

    await verify(scope, id);
    const after = await run<{ settles: string; settles_npr: string }>(
      scope.organizationId,
      'SELECT settles, settles_npr FROM app.payments WHERE id = $1',
      [id],
    );
    expect(after).toEqual({ settles: '1150.50', settles_npr: '1150.50' });
  });

  it('defaults tds_withheld to 0, and cannot be written directly', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope, { amount: '250.00' });
    const row = await run<{ tds_withheld: string; settles: string }>(
      scope.organizationId,
      'SELECT tds_withheld, settles FROM app.payments WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ tds_withheld: '0.00', settles: '250.00' });
    await expect(
      run(scope.organizationId, 'UPDATE app.payments SET settles = 1 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '428C9' });
  });

  it('refuses a non-positive amount and a negative TDS', async () => {
    const scope = await newScope();
    await expect(insertPayment(scope, { amount: '0.00' })).rejects.toMatchObject(
      CHECK('payments_amount_check'),
    );
    await expect(insertPayment(scope, { tds: '-1.00' })).rejects.toMatchObject(
      CHECK('payments_tds_withheld_check'),
    );
  });
});

describe('segregation of duties', () => {
  it('refuses a verification by the submitter (23514), and accepts another user', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(verify(scope, id, scope.submitter)).rejects.toMatchObject(
      CHECK('payments_verifier_check'),
    );
    const still = await run<{ status: string }>(
      scope.organizationId,
      'SELECT status FROM app.payments WHERE id = $1',
      [id],
    );
    expect(still.status).toBe('submitted');

    await verify(scope, id);
    const done = await run<{ status: string; verified_by: string }>(
      scope.organizationId,
      'SELECT status, verified_by FROM app.payments WHERE id = $1',
      [id],
    );
    expect(done).toEqual({ status: 'verified', verified_by: scope.verifier });
  });

  it('refuses a verifier on a payment that is not verified, and a verified one with no verifier', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET verified_by = $2, verified_at = now() WHERE id = $1 RETURNING id`,
        [id, scope.verifier],
      ),
    ).rejects.toMatchObject(CHECK('payments_verification_status_check'));
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments
            SET status = 'verified', number = 'RCPT-2083/84-00099', seq = 99, fiscal_year = '2083/84',
                fx_rate = 1, amount_npr = amount, tds_npr = tds_withheld
          WHERE id = $1 RETURNING id`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_verification_status_check'));
  });
});

describe('the receipt number', () => {
  it('is refused on a submitted payment (23514), whatever its parts', async () => {
    const scope = await newScope();
    await expect(
      insertPayment(scope, { number: 'RCPT-2083/84-00001', seq: 1, fiscalYear: '2083/84' }),
    ).rejects.toMatchObject(CHECK('payments_number_status_check'));
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET number = 'RCPT-2083/84-00001', seq = 1, fiscal_year = '2083/84' WHERE id = $1`,
        [await insertPayment(scope)],
      ),
    ).rejects.toMatchObject(CHECK('payments_number_status_check'));
  });

  it('is refused on a withdrawn payment', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments
            SET status = 'withdrawn', number = 'RCPT-2083/84-00002', seq = 2, fiscal_year = '2083/84'
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_number_status_check'));
  });

  it('is required once verified, with seq and fiscal year, and is unique per entity', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments
            SET status = 'verified', verified_by = $2, verified_at = now(), fx_rate = 1, amount_npr = amount,
                tds_npr = tds_withheld
          WHERE id = $1`,
        [id, scope.verifier],
      ),
    ).rejects.toMatchObject(CHECK('payments_number_status_check'));
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET number = 'RCPT-2083/84-00003' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_number_complete_check'));

    await verify(scope, id);
    const number = await run<{ number: string }>(
      scope.organizationId,
      'SELECT number FROM app.payments WHERE id = $1',
      [id],
    );
    const other = await insertPayment(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments
            SET status = 'verified', verified_by = $2, verified_at = now(), number = $3, seq = 777,
                fiscal_year = '2083/84', fx_rate = 1, amount_npr = amount, tds_npr = tds_withheld
          WHERE id = $1`,
        [other, scope.verifier, number.number],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'payments_tenant_org_number_unique' });
  });
});

describe('rejection', () => {
  it('needs a reason (23514), blank or missing, and accepts one', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(setStatus(scope, id, 'rejected')).rejects.toMatchObject(
      CHECK('payments_rejection_reason_check'),
    );
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET status = 'rejected', rejection_reason = '   ' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_rejection_reason_check'));
    await expect(
      insertPayment(scope, { status: 'rejected', rejectionReason: null }),
    ).rejects.toMatchObject(CHECK('payments_rejection_reason_check'));

    await run(
      scope.organizationId,
      `UPDATE app.payments SET status = 'rejected', rejection_reason = 'Amount does not match the slip' WHERE id = $1`,
      [id],
    );
    const row = await run<{ status: string }>(
      scope.organizationId,
      'SELECT status FROM app.payments WHERE id = $1',
      [id],
    );
    expect(row.status).toBe('rejected');
  });
});

describe('the NPR snapshot', () => {
  it('is required once verified, and an NPR payment snapshot is rate 1 with equal amounts', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments
            SET status = 'verified', verified_by = $2, verified_at = now(), number = 'RCPT-2083/84-00050',
                seq = 50, fiscal_year = '2083/84'
          WHERE id = $1`,
        [id, scope.verifier],
      ),
    ).rejects.toMatchObject(CHECK('payments_snapshot_status_check'));
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET fx_rate = 2, amount_npr = 2000.00, tds_npr = 0 WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_npr_snapshot_check'));
    await expect(
      run(scope.organizationId, `UPDATE app.payments SET fx_rate = 1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject(CHECK('payments_snapshot_complete_check'));
  });

  it('names its rate source and date for a foreign currency', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope, { currency: 'USD', amount: '100.00', tds: '5.00' });
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.payments SET fx_rate = 133.5, amount_npr = 13350.00, tds_npr = 667.50 WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(CHECK('payments_fx_source_check'));
    await run(
      scope.organizationId,
      `UPDATE app.payments
          SET fx_rate = 133.5, fx_source = 'NRB', fx_date = '2026-11-09', amount_npr = 13350.00, tds_npr = 667.50
        WHERE id = $1`,
      [id],
    );
    const row = await run<{ settles: string; settles_npr: string }>(
      scope.organizationId,
      'SELECT settles, settles_npr FROM app.payments WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ settles: '105.00', settles_npr: '14017.50' });
  });
});

describe('the customer and the TDS code', () => {
  it('takes a customer party only (23503): a vendor, a missing party and another tenant are refused', async () => {
    const scope = await newScope();
    const { partyId: vendor } = await createParty(app, {
      tenantId: scope.tenantId,
      kind: 'vendor',
    });
    await expect(insertPayment(scope, { customerPartyId: vendor })).rejects.toMatchObject(
      FK('payments_customer_party_fk'),
    );
    const foreign = await newScope();
    await expect(
      insertPayment(scope, { customerPartyId: foreign.customerId }),
    ).rejects.toMatchObject(FK('payments_customer_party_fk'));
    await expect(
      run(
        scope.organizationId,
        `INSERT INTO app.payments
           (tenant_id, organization_id, method, currency, amount, received_on, submitted_by, channel)
         VALUES ($1, $2, 'cash', 'NPR', 10, '2026-11-09', $3, 'staff')`,
        [scope.tenantId, scope.organizationId, scope.submitter],
      ),
    ).rejects.toMatchObject(CHECK('payments_customer_party_check'));
  });

  it("links an optional withholding code of the tenant, and refuses another tenant's", async () => {
    const scope = await newScope();
    const other = await newScope();
    const code = async (s: Scope) =>
      (
        await run(
          s.organizationId,
          `INSERT INTO app.withholding_codes (tenant_id, code, name, applies_to, rate_bp, effective_from)
           VALUES ($1, 'TDS_SERVICE', 'TDS on services', 'receivable', 0, '2020-01-01') RETURNING id`,
          [s.tenantId],
        )
      ).id;
    await expect(
      insertPayment(scope, { tds: '100.00', withholdingCodeId: await code(scope) }),
    ).resolves.toBeTypeOf('string');
    await expect(insertPayment(scope, { tds: '0' })).resolves.toBeTypeOf('string');
    await expect(
      insertPayment(scope, { tds: '100.00', withholdingCodeId: await code(other) }),
    ).rejects.toMatchObject(FK('payments_withholding_code_fk'));
  });
});

describe('payment proofs', () => {
  it('link a payment to a document of the same entity', async () => {
    const scope = await newScope();
    const payment = await insertPayment(scope);
    const document = await insertDocument(scope.organizationId, scope.tenantId);
    await expect(insertProof(scope, payment, document)).resolves.toBeDefined();
    await expect(insertProof(scope, payment, document)).rejects.toMatchObject({
      code: '23505',
      constraint: 'payment_proofs_tenant_org_payment_document_unique',
    });
  });

  it("refuse another entity's document (23503), though it is the same tenant's", async () => {
    const scope = await newScope();
    const otherEntity = await insertEntity(scope.tenantId);
    const payment = await insertPayment(scope);
    const foreignDocument = await insertDocument(otherEntity, scope.tenantId);
    await expect(insertProof(scope, payment, foreignDocument)).rejects.toMatchObject(
      FK('payment_proofs_document_fk'),
    );
    const none = await run<{ n: string }>(
      scope.organizationId,
      'SELECT count(*)::text AS n FROM app.payment_proofs WHERE payment_id = $1',
      [payment],
    );
    expect(none.n).toBe('0');
  });

  it("refuse another entity's payment (23503)", async () => {
    const scope = await newScope();
    const otherEntity = await insertEntity(scope.tenantId);
    const document = await insertDocument(scope.organizationId, scope.tenantId);
    const foreignPayment = await insertPayment({ ...scope, organizationId: otherEntity });
    await expect(insertProof(scope, foreignPayment, document)).rejects.toMatchObject(
      FK('payment_proofs_payment_fk'),
    );
  });

  it('are append-only: no UPDATE or DELETE for bos_app (42501), and the trigger stops the owner (23514)', async () => {
    const scope = await newScope();
    const payment = await insertPayment(scope);
    const document = await insertDocument(scope.organizationId, scope.tenantId);
    await insertProof(scope, payment, document);
    await expect(
      run(scope.organizationId, 'UPDATE app.payment_proofs SET created_by = NULL'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      run(scope.organizationId, 'DELETE FROM app.payment_proofs WHERE payment_id = $1', [payment]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query('DELETE FROM app.payment_proofs WHERE payment_id = $1', [payment]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'payment_proofs_append_only' });
  });
});

describe('the lifecycle', () => {
  it('moves submitted -> verified -> reversed, and keeps the number on reversal', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await verify(scope, id);
    await setStatus(scope, id, 'reversed');
    const row = await run<{ status: string; number: string }>(
      scope.organizationId,
      'SELECT status, number FROM app.payments WHERE id = $1',
      [id],
    );
    expect(row.status).toBe('reversed');
    expect(row.number).toMatch(/^RCPT-2083\/84-\d{5}$/);
  });

  it('refuses a move the lifecycle does not know (23514)', async () => {
    const scope = await newScope();
    const submitted = await insertPayment(scope);
    await expect(setStatus(scope, submitted, 'reversed')).rejects.toMatchObject(
      CHECK('payments_status_transition_check'),
    );
    const verified = await insertPayment(scope);
    await verify(scope, verified);
    for (const status of ['submitted', 'rejected', 'withdrawn']) {
      await expect(setStatus(scope, verified, status), status).rejects.toMatchObject(
        CHECK('payments_status_transition_check'),
      );
    }
    const withdrawn = await insertPayment(scope);
    await setStatus(scope, withdrawn, 'withdrawn');
    await expect(setStatus(scope, withdrawn, 'submitted')).rejects.toMatchObject(
      CHECK('payments_status_transition_check'),
    );
  });

  it('freezes the content of a decided payment (23514): only status, version and updated_at move', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await verify(scope, id);
    for (const change of [
      'amount = 1.00, amount_npr = 1.00',
      'tds_withheld = 5.00',
      "bank_reference = 'TXN-2'",
      'received_on = received_on + 1',
      "method = 'cash'",
      'withholding_code_id = NULL, number = number',
    ]) {
      const attempt = run(
        scope.organizationId,
        `UPDATE app.payments SET ${change} WHERE id = $1 RETURNING id`,
        [id],
      );
      if (change.startsWith('withholding_code_id')) {
        await expect(attempt, change).resolves.toBeDefined(); // no actual change: still allowed
      } else {
        await expect(attempt, change).rejects.toMatchObject({ code: '23514' });
      }
    }
    const rejected = await insertPayment(scope);
    await run(
      scope.organizationId,
      `UPDATE app.payments SET status = 'rejected', rejection_reason = 'wrong account' WHERE id = $1`,
      [rejected],
    );
    await expect(
      run(scope.organizationId, `UPDATE app.payments SET amount = 2 WHERE id = $1`, [rejected]),
    ).rejects.toMatchObject(CHECK('payments_frozen_check'));
  });

  it('lets a submitted payment be edited before anyone decides', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    const row = await run<{ amount: string; settles: string; version: number }>(
      scope.organizationId,
      `UPDATE app.payments SET amount = 900.00, bank_reference = 'TXN-9', version = version + 1
        WHERE id = $1 RETURNING amount, settles, version`,
      [id],
    );
    expect(row).toEqual({ amount: '900.00', settles: '900.00', version: 2 });
  });

  it('refuses DELETE of a payment to bos_app (42501)', async () => {
    const scope = await newScope();
    const id = await insertPayment(scope);
    await expect(
      run(scope.organizationId, 'DELETE FROM app.payments WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
