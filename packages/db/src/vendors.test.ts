// Integration tests for 0032_vendors (P4 unit S-V) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/vendors.test.ts
//
// What 0032 must hold:
//   * the migrations apply on a fresh database, and the four vendor tables exist;
//   * checkTenancy() with its strict defaults (vendors, vendor_contacts and vendor_bank_accounts are listed in
//     TENANT_SCOPED) and checkAudit() find nothing;
//   * a vendor's id must be a vendor party, never a customer party (the kind FK);
//   * a vendor cannot be approved by the person who created it, and an approved vendor names its approver;
//   * a PAN is required, nine digits, unless the vendor is foreign; unique within a tenant, free across tenants;
//   * a bank account cannot be verified by its proposer (maker-checker), an active one has a verifier and a
//     call-back evidence document, and a vendor has at most one active account;
//   * a vendor account belongs to one legal entity of the vendor's own tenant, once per entity;
//   * the encrypted account number never reaches the audit trail.
//
// Setup mirrors crm.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app. Tenant-level rows are audited under the acting entity, which inTx() sets, like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createStaffUser, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const VENDOR_TABLES = [
  'vendors',
  'vendor_contacts',
  'vendor_accounts',
  'vendor_bank_accounts',
] as const;

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
  /** A staff user of the tenant (the creator and proposer in these tests). */
  userId: string;
  /** A second staff user (the approver and verifier). */
  otherUserId: string;
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

/** A tenant, its default entity and two staff users. */
async function newScope(): Promise<Scope> {
  const tenant = await createTenantWithEntity(app);
  const { tenantId, organizationId, idpOrgId } = tenant;
  const { userId } = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  const other = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  return { tenantId, organizationId, userId, otherUserId: other.userId };
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

/** A nine-digit Nepali PAN that no other test uses. */
function newPan(): string {
  return `${randomUUID().replaceAll(/\D/g, '').padEnd(9, '7').slice(0, 9)}`;
}

interface VendorOptions {
  kind?: string;
  pan?: string | null;
  country?: string;
  status?: string;
  createdBy?: string;
  approvedBy?: string | null;
}

function insertVendorRow(scope: Scope, id: string, options: VendorOptions = {}): Promise<unknown> {
  const kind = options.kind ?? 'company';
  const pan = options.pan === undefined ? (kind === 'foreign' ? null : newPan()) : options.pan;
  return inTx(scope.organizationId, (c) =>
    c.query(
      `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, status, created_by, approved_by)
       VALUES ($1, $2, 'Himal Supplies Pvt. Ltd.', $3, $4, $5, $6, $7, $8)`,
      [
        id,
        scope.tenantId,
        kind,
        pan,
        options.country ?? (kind === 'foreign' ? 'IN' : 'NP'),
        options.status ?? 'draft',
        options.createdBy ?? scope.userId,
        options.approvedBy ?? null,
      ],
    ),
  );
}

/** A vendor party and its vendor row. */
async function insertVendor(scope: Scope, options: VendorOptions = {}): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'vendor' });
  await insertVendorRow(scope, partyId, options);
  return partyId;
}

/** A vendor account of `vendorId` in the entity `organizationId` of `tenantId`. */
function insertVendorAccount(
  tenantId: string,
  organizationId: string,
  vendorId: string,
): Promise<unknown> {
  return inTx(organizationId, (c) =>
    c.query(
      `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
       VALUES ($1, $2, $3, 'NPR')`,
      [tenantId, organizationId, vendorId],
    ),
  );
}

/** A document of `scope`'s default entity, the call-back evidence of a bank account. */
async function insertDocument(tenantId: string, organizationId: string): Promise<string> {
  const { rows } = await inTx(organizationId, (c) =>
    c.query<{ id: string }>(
      `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
       VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
      [tenantId, organizationId, randomUUID()],
    ),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('document insert returned no row');
  return id;
}

interface BankOptions {
  status?: string;
  verifiedBy?: string | null;
  evidenceDocumentId?: string | null;
  proposedBy?: string;
  last4?: string;
  proposedVia?: string;
  accountNumber?: string;
}

function insertBankAccount(
  scope: Scope,
  vendorId: string,
  options: BankOptions = {},
): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.vendor_bank_accounts
         (tenant_id, vendor_id, bank_name, account_name, account_number_enc, account_fingerprint, last4,
          status, proposed_by, proposed_via, verified_by, callback_evidence_document_id)
       VALUES ($1, $2, 'Nabil Bank', 'Himal Supplies', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        scope.tenantId,
        vendorId,
        Buffer.from(options.accountNumber ?? 'ciphertext-of-0123456789'),
        randomUUID().replaceAll('-', ''),
        options.last4 ?? '6789',
        options.status ?? 'proposed',
        options.proposedBy ?? scope.userId,
        options.proposedVia ?? 'staff',
        options.verifiedBy ?? null,
        options.evidenceDocumentId ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('bank account insert returned no row');
    return id;
  });
}

/** An active bank account: verified by the other user, with call-back evidence. */
async function insertActiveBankAccount(scope: Scope, vendorId: string): Promise<string> {
  const evidenceDocumentId = await insertDocument(scope.tenantId, scope.organizationId);
  return insertBankAccount(scope, vendorId, {
    status: 'active',
    verifiedBy: scope.otherUserId,
    evidenceDocumentId,
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:vendors-test'],
    ['bos.correlation_id', 'vendors-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('0032_vendors on a fresh database', () => {
  it('applies, and creates the four vendor tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...VENDOR_TABLES]],
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

  it('records a vendor write in the audit trail under the acting entity', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    const { rows } = await owner.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'vendors' AND entity_id = $2`,
      [scope.tenantId, vendorId],
    );
    expect(rows).toEqual([{ organization_id: scope.organizationId }]);
  });
});

describe('a vendor is a vendor party', () => {
  it('refuses a vendor whose id is a customer party (23503)', async () => {
    const scope = await newScope();
    const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'customer' });
    await expect(insertVendorRow(scope, partyId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendors_party_fk',
    });
  });

  it('refuses a vendor with no party at all (23503) and accepts a vendor party', async () => {
    const scope = await newScope();
    await expect(insertVendorRow(scope, randomUUID())).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendors_party_fk',
    });
    await expect(insertVendor(scope)).resolves.toBeTypeOf('string');
  });

  it("refuses a vendor whose party is another tenant's (23503)", async () => {
    const a = await newScope();
    const b = await newScope();
    const { partyId } = await createParty(app, { tenantId: b.tenantId, kind: 'vendor' });
    await expect(insertVendorRow(a, partyId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendors_party_fk',
    });
  });
});

describe('vendor approval is maker-checker', () => {
  it('refuses an approver who is the creator (23514)', async () => {
    const scope = await newScope();
    await expect(
      insertVendor(scope, { status: 'approved', approvedBy: scope.userId }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'vendors_approved_by_check' });
    await expect(
      insertVendor(scope, { status: 'approved', approvedBy: scope.otherUserId }),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses an approved vendor with no approver (23514)', async () => {
    const scope = await newScope();
    await expect(insertVendor(scope, { status: 'approved' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_approval_check',
    });
  });

  it('refuses a status outside the catalogue (23514)', async () => {
    const scope = await newScope();
    await expect(insertVendor(scope, { status: 'verified' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_status_check',
    });
  });
});

describe('PAN', () => {
  it('is required, nine digits, for a Nepali vendor (23514)', async () => {
    const scope = await newScope();
    await expect(insertVendor(scope, { pan: null })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_pan_check',
    });
    await expect(insertVendor(scope, { pan: '12345' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_pan_check',
    });
    await expect(insertVendor(scope, { pan: 'abcdefghi' })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('may be absent for a foreign vendor, which must have a foreign country (23514)', async () => {
    const scope = await newScope();
    await expect(insertVendor(scope, { kind: 'foreign' })).resolves.toBeTypeOf('string');
    await expect(insertVendor(scope, { kind: 'foreign', country: 'NP' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_foreign_country_check',
    });
    await expect(insertVendor(scope, { kind: 'company', country: 'IN' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendors_foreign_country_check',
    });
  });

  it('is unique within a tenant (23505) and free across tenants', async () => {
    const a = await newScope();
    const b = await newScope();
    const pan = newPan();
    await insertVendor(a, { pan });
    await expect(insertVendor(a, { pan })).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendors_tenant_pan_unique',
    });
    await expect(insertVendor(b, { pan })).resolves.toBeTypeOf('string');
    // Foreign vendors without a PAN do not collide.
    await insertVendor(a, { kind: 'foreign' });
    await expect(insertVendor(a, { kind: 'foreign' })).resolves.toBeTypeOf('string');
  });
});

describe('vendor bank accounts: maker-checker and one active', () => {
  it('refuses a verifier who is the proposer (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    const evidenceDocumentId = await insertDocument(scope.tenantId, scope.organizationId);
    await expect(
      insertBankAccount(scope, vendorId, {
        status: 'active',
        verifiedBy: scope.userId,
        evidenceDocumentId,
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_bank_accounts_maker_checker_check',
    });
    // Control: a different verifier is accepted.
    await expect(insertActiveBankAccount(scope, vendorId)).resolves.toBeTypeOf('string');
  });

  it('refuses an active account with no verifier or no call-back evidence (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    const evidenceDocumentId = await insertDocument(scope.tenantId, scope.organizationId);
    const failure = { code: '23514', constraint: 'vendor_bank_accounts_active_check' };

    await expect(
      insertBankAccount(scope, vendorId, { status: 'active', verifiedBy: scope.otherUserId }),
    ).rejects.toMatchObject(failure);
    await expect(
      insertBankAccount(scope, vendorId, { status: 'active', evidenceDocumentId }),
    ).rejects.toMatchObject(failure);
    // A proposed account needs neither.
    await expect(insertBankAccount(scope, vendorId)).resolves.toBeTypeOf('string');
  });

  it('refuses a second active account for the same vendor (23505)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    const first = await insertActiveBankAccount(scope, vendorId);

    await expect(insertActiveBankAccount(scope, vendorId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendor_bank_accounts_tenant_vendor_active_unique',
    });
    // Other vendors, and any number of proposed or rejected accounts, are free.
    await expect(insertActiveBankAccount(scope, await insertVendor(scope))).resolves.toBeTypeOf(
      'string',
    );
    await insertBankAccount(scope, vendorId);
    await expect(insertBankAccount(scope, vendorId, { status: 'rejected' })).resolves.toBeTypeOf(
      'string',
    );
    // Retiring the active account frees the slot.
    await inTx(scope.organizationId, (c) =>
      c.query(`UPDATE app.vendor_bank_accounts SET status = 'retired' WHERE id = $1`, [first]),
    );
    await expect(insertActiveBankAccount(scope, vendorId)).resolves.toBeTypeOf('string');
  });

  it('refuses a status or proposal channel outside the catalogue, and a last4 that is not 4 digits (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    await expect(insertBankAccount(scope, vendorId, { status: 'pending' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_bank_accounts_status_check',
    });
    await expect(
      insertBankAccount(scope, vendorId, { proposedVia: 'email' }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_bank_accounts_proposed_via_check',
    });
    await expect(insertBankAccount(scope, vendorId, { last4: '678' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_bank_accounts_last4_check',
    });
  });

  it("refuses evidence that is another tenant's document, and a vendor of another tenant (23503)", async () => {
    const a = await newScope();
    const b = await newScope();
    const vendorOfA = await insertVendor(a);
    const documentOfB = await insertDocument(b.tenantId, b.organizationId);
    await expect(
      insertBankAccount(a, vendorOfA, {
        status: 'active',
        verifiedBy: a.otherUserId,
        evidenceDocumentId: documentOfB,
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_bank_accounts_evidence_document_fk',
    });
    const vendorOfB = await insertVendor(b);
    await expect(insertBankAccount(a, vendorOfB)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_bank_accounts_vendor_fk',
    });
  });

  it('keeps the encrypted account number out of the audit trail', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    const id = await insertBankAccount(scope, vendorId, {
      accountNumber: 'distinctive-ciphertext-marker',
    });
    const { rows } = await owner.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'vendor_bank_accounts' AND entity_id = $2`,
      [scope.tenantId, id],
    );
    expect(rows).toHaveLength(1);
    const after = rows[0]?.after ?? {};
    expect(after).toMatchObject({ last4: '6789', status: 'proposed' });
    expect(Object.keys(after)).not.toContain('account_number_enc');
    expect(JSON.stringify(after)).not.toContain(
      Buffer.from('distinctive-ciphertext-marker').toString('hex'),
    );
  });
});

describe('vendor accounts belong to one legal entity of the vendor tenant', () => {
  it("refuses an entity of another tenant (23503): organization_id is not the vendor's tenant's", async () => {
    const a = await newScope();
    const b = await newScope();
    const vendorOfA = await insertVendor(a);
    await expect(
      insertVendorAccount(a.tenantId, b.organizationId, vendorOfA),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_accounts_tenant_org_fk' });
  });

  it("refuses another tenant's vendor (23503)", async () => {
    const a = await newScope();
    const b = await newScope();
    const vendorOfB = await insertVendor(b);
    await expect(
      insertVendorAccount(a.tenantId, a.organizationId, vendorOfB),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_accounts_vendor_fk' });
  });

  it('gives one vendor one account per entity, shared tenant-level vendor across entities', async () => {
    const a = await newScope();
    const secondEntity = await insertEntity(a.tenantId);
    const vendorId = await insertVendor(a);

    await insertVendorAccount(a.tenantId, a.organizationId, vendorId);
    await expect(insertVendorAccount(a.tenantId, secondEntity, vendorId)).resolves.toBeDefined();
    await expect(insertVendorAccount(a.tenantId, a.organizationId, vendorId)).rejects.toMatchObject(
      {
        code: '23505',
        constraint: 'vendor_accounts_tenant_org_vendor_unique',
      },
    );
  });

  it('refuses a payment term of another tenant (23503) and a currency outside NPR/INR/USD (23514)', async () => {
    const a = await newScope();
    const b = await newScope();
    const vendorId = await insertVendor(a);
    const { rows } = await inTx(b.organizationId, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO app.payment_terms (tenant_id, code, name, net_days) VALUES ($1, 'N30', 'Net 30', 30) RETURNING id`,
        [b.tenantId],
      ),
    );
    const termOfB = rows[0]?.id;
    await expect(
      inTx(a.organizationId, (c) =>
        c.query(
          `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, payment_term_id)
           VALUES ($1, $2, $3, $4)`,
          [a.tenantId, a.organizationId, vendorId, termOfB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_accounts_payment_term_fk' });
    await expect(
      inTx(a.organizationId, (c) =>
        c.query(
          `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
           VALUES ($1, $2, $3, 'EUR')`,
          [a.tenantId, a.organizationId, vendorId],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_accounts_default_currency_check',
    });
  });

  it('constrains default_withholding_code_id to a withholding code of the tenant (S-AP, 0035)', async () => {
    const a = await newScope();
    const vendorId = await insertVendor(a);
    await expect(
      inTx(a.organizationId, (c) =>
        c.query(
          `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_withholding_code_id)
           VALUES ($1, $2, $3, $4)`,
          [a.tenantId, a.organizationId, vendorId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_accounts_default_withholding_code_fk',
    });
  });
});

describe('vendor contacts', () => {
  const insertContact = (scope: Scope, vendorId: string, isPrimary: boolean, email = 'a@b.np') =>
    inTx(scope.organizationId, (c) =>
      c.query(
        `INSERT INTO app.vendor_contacts (tenant_id, vendor_id, full_name, email_norm, is_primary)
         VALUES ($1, $2, 'Sita Sharma', $3, $4)`,
        [scope.tenantId, vendorId, email, isPrimary],
      ),
    );

  it('allows one primary contact per vendor (23505) and lower-case emails only (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    await insertContact(scope, vendorId, true);
    await expect(insertContact(scope, vendorId, true)).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendor_contacts_tenant_vendor_primary_unique',
    });
    await expect(insertContact(scope, vendorId, false)).resolves.toBeDefined();
    await expect(insertContact(scope, vendorId, false, 'A@B.np')).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_contacts_email_norm_check',
    });
  });

  it("refuses another tenant's vendor (23503)", async () => {
    const a = await newScope();
    const b = await newScope();
    const vendorOfB = await insertVendor(b);
    await expect(insertContact(a, vendorOfB, false)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_contacts_vendor_fk',
    });
  });
});
