// Integration tests for 0016_quotations (P2 unit S2) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/quotations.test.ts
//
// What 0016 must hold:
//   * the migrations apply on a fresh database (btree_gist included), and the nine quotation tables exist;
//   * checkTenancy() with its defaults (strict) and checkAudit() find nothing;
//   * a tax code's effective periods never overlap within a tenant;
//   * a quotation has at most one live version (draft, submitted, returned, approved, sent); a superseded one
//     plus a new draft is fine, and a revision number is used once;
//   * once a version leaves draft/returned, its material columns and its lines are frozen, while status and
//     render columns still move; the freeze cannot be undone by setting the status back to draft;
//   * a version cannot hang off another entity's quotation, and the current version is the quotation's own;
//   * a vendor party cannot be a quotation's customer;
//   * the three foreign keys S1 left for S2 are enforced.
//
// Setup mirrors crm.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as bos_owner,
// write as bos_app, with the acting entity set per transaction like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const QUOTATION_TABLES = [
  'tax_codes',
  'payment_terms',
  'quotations',
  'quotation_versions',
  'quotation_lines',
  'quotation_tax_summary',
  'quotation_version_editors',
  'quotation_acceptances',
  'quotation_status_history',
] as const;

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
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

/** One statement in `scope`'s entity; returns the first row's id when the statement has RETURNING id. */
async function exec(scope: Scope, sql: string, params: unknown[] = []): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const { rows } = await c.query<{ id?: string }>(sql, params);
    return rows[0]?.id ?? '';
  });
}

async function newScope(): Promise<Scope> {
  const { tenantId, organizationId } = await createTenantWithEntity(app);
  return { tenantId, organizationId };
}

/** A second legal entity of `tenantId` (the fixture made the default one). */
async function insertEntity(tenantId: string): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, false)`,
    [id, tenantId, `E-${id}`],
  );
  return id;
}

/** A customer party and its customer row (tenant-level). */
async function insertCustomer(scope: Scope): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'customer' });
  await exec(
    scope,
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', 'Durbar Marg 1', 'Kathmandu')`,
    [partyId, scope.tenantId, `CUS-${partyId.slice(0, 8)}`],
  );
  return partyId;
}

function insertOpportunity(scope: Scope, customerId: string): Promise<string> {
  return exec(
    scope,
    `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
     VALUES ($1, $2, $3, 'Acme website', $4) RETURNING id`,
    [scope.tenantId, scope.organizationId, `DEAL-${randomUUID().slice(0, 8)}`, customerId],
  );
}

/** A tax code period: [from, to), `to` null = open-ended. */
function insertTaxCode(
  scope: Scope,
  code: string,
  from: string,
  to: string | null = null,
  rateBp = 1300,
): Promise<string> {
  return exec(
    scope,
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from, effective_to)
     VALUES ($1, $2, 'VAT 13%', 'vat', $3, true, $4, $5) RETURNING id`,
    [scope.tenantId, code, rateBp, from, to],
  );
}

/** A quotation of `scope`'s entity on a fresh opportunity, for `customerPartyId` (a new customer by default). */
async function insertQuotation(
  scope: Scope,
  options: { customerPartyId?: string; opportunityId?: string } = {},
): Promise<string> {
  const customerPartyId = options.customerPartyId ?? (await insertCustomer(scope));
  const opportunityId = options.opportunityId ?? (await insertOpportunity(scope, customerPartyId));
  return exec(
    scope,
    `INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `QT-${randomUUID().slice(0, 8)}`,
      customerPartyId,
      opportunityId,
    ],
  );
}

/** A Draft version. Revision 1 by default; a later revision names the version it supersedes and a reason. */
function insertVersion(
  scope: Scope,
  quotationId: string,
  options: { revisionNo?: number; supersedesVersionId?: string; organizationId?: string } = {},
): Promise<string> {
  const revisionNo = options.revisionNo ?? 1;
  return exec(
    scope,
    `INSERT INTO app.quotation_versions
       (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until,
        supersedes_version_id, revision_reason)
     VALUES ($1, $2, $3, $4, 'NPR', '2026-11-09', '2026-12-09', $5, $6) RETURNING id`,
    [
      scope.tenantId,
      options.organizationId ?? scope.organizationId,
      quotationId,
      revisionNo,
      options.supersedesVersionId ?? null,
      revisionNo === 1 ? null : 'Customer asked for a lower price',
    ],
  );
}

/** Line 1 of a version: 3 x 33,333.33, no discount. */
function insertLine(
  scope: Scope,
  versionId: string,
  taxCodeId: string,
  lineNo = 1,
): Promise<string> {
  return exec(
    scope,
    `INSERT INTO app.quotation_lines
       (tenant_id, organization_id, version_id, line_no, description, uom, quantity, unit_price, tax_code_id,
        gross, discount_alloc, taxable)
     VALUES ($1, $2, $3, $4, 'Design', 'hour', 3, 33333.33, $5, 99999.99, 0, 99999.99) RETURNING id`,
    [scope.tenantId, scope.organizationId, versionId, lineNo, taxCodeId],
  );
}

const HASH = `decode(repeat('ab', 32), 'hex')`;

/** Draft -> Submitted -> Approved, writing the frozen snapshot (FX, NPR amounts, hashes) with the submit. */
async function approve(scope: Scope, versionId: string): Promise<void> {
  await exec(
    scope,
    `UPDATE app.quotation_versions
        SET status = 'submitted', submitted_at = now(), fx_rate = 1, amount_npr = total,
            npr_taxable_amount = taxable_amount, content_sha256 = ${HASH}, snapshot_sha256 = ${HASH}
      WHERE id = $1`,
    [versionId],
  );
  await exec(
    scope,
    `UPDATE app.quotation_versions SET status = 'approved', approved_at = now() WHERE id = $1`,
    [versionId],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:quotations-test'],
    ['bos.correlation_id', 'quotations-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  // bos_owner owns the database, so it may create the trusted btree_gist extension itself.

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('0016_quotations on a fresh database', () => {
  it('applies, and creates the nine quotation tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...QUOTATION_TABLES]],
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

describe('tax codes', () => {
  it('refuse an overlapping period for the same code (23P01), and allow adjacent ones', async () => {
    const scope = await newScope();
    await insertTaxCode(scope, 'VAT13', '2026-01-01', '2026-07-01');
    // [from, to): a period starting on the previous one's end date does not overlap.
    await expect(insertTaxCode(scope, 'VAT13', '2026-07-01')).resolves.toBeTypeOf('string');

    const failure = { code: '23P01', constraint: 'tax_codes_no_overlap' };
    await expect(insertTaxCode(scope, 'VAT13', '2026-06-30', '2026-07-02')).rejects.toMatchObject(
      failure,
    );
    await expect(insertTaxCode(scope, 'VAT13', '2027-01-01')).rejects.toMatchObject(failure);
    // A VAT code needs a rate above zero (zero is the exempt and zero-rated kinds).
    await expect(insertTaxCode(scope, 'VAT0', '2026-01-01', null, 0)).rejects.toMatchObject({
      code: '23514',
      constraint: 'tax_codes_rate_kind_check',
    });
    // Another code, or the same code in another tenant, is free.
    await expect(insertTaxCode(scope, 'VAT13-IMPORT', '2026-01-01')).resolves.toBeTypeOf('string');
    const other = await newScope();
    await expect(insertTaxCode(other, 'VAT13', '2026-01-01')).resolves.toBeTypeOf('string');
  });
});

describe('one live version per quotation', () => {
  it('refuses a second live version (23505), and allows a superseded one plus a new draft', async () => {
    const scope = await newScope();
    const quotationId = await insertQuotation(scope);
    const v1 = await insertVersion(scope, quotationId);
    const live = { code: '23505', constraint: 'one_live_version' };

    await expect(
      insertVersion(scope, quotationId, { revisionNo: 2, supersedesVersionId: v1 }),
    ).rejects.toMatchObject(live);
    await approve(scope, v1);
    await expect(
      insertVersion(scope, quotationId, { revisionNo: 2, supersedesVersionId: v1 }),
    ).rejects.toMatchObject(live);

    // Revise: the old version leaves the live set first, then the new draft is written, then the back-link.
    await exec(scope, `UPDATE app.quotation_versions SET status = 'superseded' WHERE id = $1`, [
      v1,
    ]);
    const v2 = await insertVersion(scope, quotationId, { revisionNo: 2, supersedesVersionId: v1 });
    await expect(
      exec(scope, `UPDATE app.quotation_versions SET superseded_by_version_id = $2 WHERE id = $1`, [
        v1,
        v2,
      ]),
    ).resolves.toBe('');
  });

  it('refuses a duplicate revision number (23505)', async () => {
    const scope = await newScope();
    const quotationId = await insertQuotation(scope);
    const v1 = await insertVersion(scope, quotationId);
    await exec(
      scope,
      `UPDATE app.quotation_versions SET status = 'cancelled', cancel_reason = 'Duplicate', cancelled_at = now()
        WHERE id = $1`,
      [v1],
    );
    await expect(insertVersion(scope, quotationId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'quotation_versions_tenant_quotation_revision_unique',
    });
  });
});

describe('quotation discount precision', () => {
  it('rejects fractional paisa for amount discounts and accepts four-place percentages', async () => {
    const scope = await newScope();
    const versionId = await insertVersion(scope, await insertQuotation(scope));
    const updateDiscount = (mode: string, value: string) =>
      exec(
        scope,
        `UPDATE app.quotation_versions SET discount_mode = $2, discount_input = $3 WHERE id = $1`,
        [versionId, mode, value],
      );

    await expect(updateDiscount('amount', '1.005')).rejects.toMatchObject({
      code: '23514',
      constraint: 'quotation_versions_amount_discount_precision_check',
    });
    await expect(updateDiscount('amount', '1.01')).resolves.toBe('');
    await expect(updateDiscount('pct', '1.0051')).resolves.toBe('');
  });
});

describe('a frozen version', () => {
  it('refuses line edits once approved (23514), and allows them on a draft', async () => {
    const scope = await newScope();
    const taxCodeId = await insertTaxCode(scope, 'VAT13', '2026-01-01');
    const quotationId = await insertQuotation(scope);
    const versionId = await insertVersion(scope, quotationId);
    const lineId = await insertLine(scope, versionId, taxCodeId);

    // Draft: editable.
    await expect(
      exec(scope, `UPDATE app.quotation_lines SET description = 'UX design' WHERE id = $1`, [
        lineId,
      ]),
    ).resolves.toBe('');

    await approve(scope, versionId);
    const frozen = { code: '23514', constraint: 'quotation_lines_frozen_check' };
    await expect(
      exec(scope, `UPDATE app.quotation_lines SET description = 'Changed' WHERE id = $1`, [lineId]),
    ).rejects.toMatchObject(frozen);
    await expect(insertLine(scope, versionId, taxCodeId, 2)).rejects.toMatchObject(frozen);
    await expect(
      exec(scope, `DELETE FROM app.quotation_lines WHERE id = $1`, [lineId]),
    ).rejects.toMatchObject(frozen);
  });

  it('refuses a material change once approved, but allows status and render updates', async () => {
    const scope = await newScope();
    const quotationId = await insertQuotation(scope);
    const versionId = await insertVersion(scope, quotationId);
    await exec(scope, `UPDATE app.quotation_versions SET scope = 'Website' WHERE id = $1`, [
      versionId,
    ]);
    await approve(scope, versionId);

    await expect(
      exec(scope, `UPDATE app.quotation_versions SET valid_until = '2027-01-31' WHERE id = $1`, [
        versionId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'quotation_versions_frozen_check' });
    // Setting the status back to draft would unlock it, so that transition is refused too.
    await expect(
      exec(scope, `UPDATE app.quotation_versions SET status = 'draft' WHERE id = $1`, [versionId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'quotation_versions_transition_check' });

    await expect(
      exec(
        scope,
        `UPDATE app.quotation_versions SET render_state = 'pending', version = version + 1 WHERE id = $1`,
        [versionId],
      ),
    ).resolves.toBe('');
    await expect(
      exec(
        scope,
        `UPDATE app.quotation_versions SET status = 'sent', sent_at = now() WHERE id = $1`,
        [versionId],
      ),
    ).resolves.toBe('');
  });

  it('cannot be unfrozen in two hops through submitted (23514)', async () => {
    const scope = await newScope();
    const quotationId = await insertQuotation(scope);
    const versionId = await insertVersion(scope, quotationId);
    await approve(scope, versionId);
    // approved -> submitted -> returned would make it editable again; only draft and returned reach submitted.
    await expect(
      exec(scope, `UPDATE app.quotation_versions SET status = 'submitted' WHERE id = $1`, [
        versionId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'quotation_versions_transition_check' });
  });

  it('refuses a version that starts in any status but draft (23514)', async () => {
    const scope = await newScope();
    const quotationId = await insertQuotation(scope);
    await expect(
      exec(
        scope,
        `INSERT INTO app.quotation_versions
           (tenant_id, organization_id, quotation_id, revision_no, status, currency, issue_date, valid_until,
            fx_rate, amount_npr, npr_taxable_amount, content_sha256, snapshot_sha256)
         VALUES ($1, $2, $3, 1, 'approved', 'NPR', '2026-11-09', '2026-12-09', 1, 0, 0, ${HASH}, ${HASH})`,
        [scope.tenantId, scope.organizationId, quotationId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'quotation_versions_insert_draft_check' });
  });
});

describe('entity and party boundaries', () => {
  it("refuses a version of entity B on entity A's quotation (23503)", async () => {
    const a = await newScope();
    const b = await insertEntity(a.tenantId);
    const quotationId = await insertQuotation(a);
    await expect(insertVersion(a, quotationId, { organizationId: b })).rejects.toMatchObject({
      code: '23503',
      constraint: 'quotation_versions_quotation_fk',
    });
  });

  it('refuses a current version that belongs to another quotation (23503)', async () => {
    const scope = await newScope();
    const q1 = await insertQuotation(scope);
    const q2 = await insertQuotation(scope);
    const v2 = await insertVersion(scope, q2);
    await expect(
      exec(scope, `UPDATE app.quotations SET current_version_id = $2 WHERE id = $1`, [q1, v2]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'quotations_current_version_fk' });
    await expect(
      exec(scope, `UPDATE app.quotations SET current_version_id = $2 WHERE id = $1`, [q2, v2]),
    ).resolves.toBe('');
  });

  it('refuses a vendor party as the customer (23503)', async () => {
    const scope = await newScope();
    const customerId = await insertCustomer(scope);
    const opportunityId = await insertOpportunity(scope, customerId);
    const { partyId: vendorId } = await createParty(app, {
      tenantId: scope.tenantId,
      kind: 'vendor',
    });
    // Both foreign keys refuse it: the kind check, and "a customer row exists" (a vendor never has one).
    await expect(
      insertQuotation(scope, { customerPartyId: vendorId, opportunityId }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: expect.stringMatching(/^quotations_customer(_party)?_fk$/) as unknown,
    });
  });
});

describe('the foreign keys S1 left for S2', () => {
  it('party_accounts.payment_term_id must name a payment term of the tenant (23503)', async () => {
    const scope = await newScope();
    const customerId = await insertCustomer(scope);
    const insertAccount = (paymentTermId: string) =>
      exec(
        scope,
        `INSERT INTO app.party_accounts (tenant_id, organization_id, party_id, payment_term_id)
         VALUES ($1, $2, $3, $4)`,
        [scope.tenantId, scope.organizationId, customerId, paymentTermId],
      );
    await expect(insertAccount(randomUUID())).rejects.toMatchObject({
      code: '23503',
      constraint: 'party_accounts_payment_term_fk',
    });
    const termId = await exec(
      scope,
      `INSERT INTO app.payment_terms (tenant_id, code, name, net_days) VALUES ($1, 'NET15', 'Net 15', 15)
       RETURNING id`,
      [scope.tenantId],
    );
    await expect(insertAccount(termId)).resolves.toBe('');
  });

  it("opportunities.won_quotation_version_id must be a version of the opportunity's entity (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const versionOfB = await insertVersion(b, await insertQuotation(b));
    const opportunityOfA = await insertOpportunity(a, await insertCustomer(a));
    await expect(
      exec(a, `UPDATE app.opportunities SET won_quotation_version_id = $2 WHERE id = $1`, [
        opportunityOfA,
        versionOfB,
      ]),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'opportunities_won_quotation_version_fk',
    });
  });

  it("activities.quotation_id must be a quotation of the activity's entity (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const quotationOfB = await insertQuotation(b);
    const insertActivity = (scope: Scope, quotationId: string) =>
      exec(
        scope,
        `INSERT INTO app.activities (tenant_id, organization_id, kind, subject, quotation_id)
         VALUES ($1, $2, 'note', 'Sent the quote', $3)`,
        [scope.tenantId, scope.organizationId, quotationId],
      );
    await expect(insertActivity(a, quotationOfB)).rejects.toMatchObject({
      code: '23503',
      constraint: 'activities_quotation_fk',
    });
    await expect(insertActivity(b, quotationOfB)).resolves.toBe('');
  });
});
