// The kernel seed against a database of the shared test cluster (vitest-global-setup.ts, needs Docker), migrated
// to the latest migration. The fake-client tests in db-seed.test.ts pin the SQL; these prove what the fakes cannot: the 0079
// department-head triggers agree with what the seed files, a re-run writes nothing (not even an audit row), and a
// reseed leaves the Founder's own grants and level rows alone.
// Run with: pnpm --filter ./tools/seed-zitadel exec vitest run src/db-seed.pg.test.ts
import { randomUUID } from 'node:crypto';

import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createParty, createTenantWithEntity } from '../../../packages/db/src/testing/fixtures.js';
import { EXTRA_VENDORS } from './personas.js';
import {
  DEV_CUSTOMER_NAME_NORM,
  DEV_CUSTOMER_PARTY_CODE,
  DEV_FOREIGN_CUSTOMER,
  DEV_FOREIGN_VENDOR,
  DEV_VENDOR_PARTY_CODE,
  type DevPersona,
  type SeedScope,
  seedKernelRows,
} from './db-seed.js';

/** A copy of the migrated template database. */
const SETUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 60_000;

let testDb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // The seed runs as the table owner, like the real tool.
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 3 });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
}, 60_000);

/** A tenant with its TR-like entity, staff IdP org and the VEND-DEV and CUST-DEV parties the tenancy step creates. */
async function devTenant(): Promise<SeedScope & { idpOrgId: string }> {
  const tenant = await createTenantWithEntity(owner);
  await createParty(owner, {
    tenantId: tenant.tenantId,
    kind: 'vendor',
    code: DEV_VENDOR_PARTY_CODE,
  });
  for (const extra of EXTRA_VENDORS) {
    await createParty(owner, { tenantId: tenant.tenantId, kind: 'vendor', code: extra.partyCode });
  }
  await createParty(owner, {
    tenantId: tenant.tenantId,
    kind: 'customer',
    code: DEV_CUSTOMER_PARTY_CODE,
  });
  return { ...tenant, correlationId: `pg-test-${randomUUID()}` };
}

/** seedKernelRows runs its own BEGIN/COMMIT, so it gets one dedicated connection. */
async function seed(scope: SeedScope, personas?: readonly DevPersona[]): Promise<number> {
  const client = await owner.connect();
  try {
    return await seedKernelRows(client, scope, personas);
  } finally {
    client.release();
  }
}

/** A write outside the seed, as some other actor (the audit triggers refuse a write without one). */
async function asFounder<T>(scope: SeedScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.tenant_id', $1, true), set_config('bos.organization_id', $2, true),
              set_config('bos.actor_kind', 'system', true), set_config('bos.actor_id', 'system:pg-test', true),
              set_config('bos.correlation_id', $3, true), set_config('bos.ip', '', true),
              set_config('bos.user_agent', '', true)`,
      [scope.tenantId, scope.organizationId, `pg-test:${randomUUID()}`],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const DEPARTMENT_PEOPLE = [
  'procurement',
  'management',
  'depthead',
  'warehouse',
  'sales',
  'sales2',
  'salesmgr',
  'saleshead',
  'marketing',
  'marketingmgr',
  'marketinghead',
];

/** The personas the dev step needs. users.zitadel_user_id is unique across tenants, so each test has a prefix. */
const personasFor = (prefix: string): DevPersona[] =>
  DEPARTMENT_PEOPLE.map((key) => ({
    personaKey: key,
    zitadelUserId: `${prefix}-${key}`,
    email: `${key}@${prefix}.test`,
    displayName: `Dev ${key}`,
  }));

async function auditCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(rows[0]?.n);
}

describe('dev people step on Postgres', () => {
  it(
    'files every person at their level under the right head, keeps an existing dev database, and a re-run changes nothing',
    async () => {
      const scope = await devTenant();
      const prefix = `pg-people-${randomUUID().slice(0, 8)}`;
      const personas = personasFor(prefix);
      const zid = (key: string) => `${prefix}-${key}`;

      // A dev database from before phase 2: depthead heads Operations but is not filed in it, procurement is
      // Operations staff, and the user mirror already made `sales` (role_keys NULL keeps every token role).
      const before = await asFounder(scope, async (client) => {
        const ids: Record<string, string> = {};
        for (const key of ['depthead', 'procurement', 'sales']) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO app.users (tenant_id, idp_org_id, zitadel_user_id, email, display_name, status)
             VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
            [scope.tenantId, scope.idpOrgId, zid(key), `${key}@${prefix}.test`, `Dev ${key}`],
          );
          ids[key] = rows[0]?.id ?? '';
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO app.departments (tenant_id, organization_id, name, head_user_id)
           VALUES ($1, $2, 'Operations', $3) RETURNING id`,
          [scope.tenantId, scope.organizationId, ids['depthead']],
        );
        const operationsId = rows[0]?.id ?? '';
        await client.query(
          `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, department_id)
           VALUES ($1, $2, $3, true, NULL), ($1, $2, $4, true, $5), ($1, $2, $6, true, NULL)`,
          [
            scope.tenantId,
            scope.organizationId,
            ids['depthead'],
            ids['procurement'],
            operationsId,
            ids['sales'],
          ],
        );
        return { operationsId };
      });

      expect(await seed(scope, personas)).toBeGreaterThan(0);

      const departments = await owner.query<{ id: string; name: string; head: string | null }>(
        `SELECT d.id, d.name, u.zitadel_user_id AS head
         FROM app.departments d LEFT JOIN app.users u ON u.id = d.head_user_id
         WHERE d.tenant_id = $1 ORDER BY d.name`,
        [scope.tenantId],
      );
      expect(departments.rows.map((d) => [d.name, d.head])).toEqual([
        ['Marketing', zid('marketinghead')],
        ['Operations', zid('depthead')],
        ['Sales', zid('saleshead')],
      ]);
      // The pre-phase-2 Operations row is reused, not duplicated.
      expect(departments.rows.find((d) => d.name === 'Operations')?.id).toBe(before.operationsId);

      const members = await owner.query<{
        zitadel_user_id: string;
        department: string | null;
        level: string;
        role_keys: string[] | null;
      }>(
        `SELECT u.zitadel_user_id, d.name AS department, ue.level, ue.role_keys
         FROM app.user_entities ue
         JOIN app.users u ON u.id = ue.user_id
         LEFT JOIN app.departments d ON d.id = ue.department_id
         WHERE ue.tenant_id = $1`,
        [scope.tenantId],
      );
      const filed = Object.fromEntries(
        members.rows.map((m) => [
          m.zitadel_user_id.slice(prefix.length + 1),
          [m.department, m.level],
        ]),
      );
      expect(filed).toEqual({
        procurement: ['Operations', 'staff'],
        depthead: ['Operations', 'head'],
        management: [null, 'staff'],
        warehouse: [null, 'staff'],
        sales: ['Sales', 'staff'],
        sales2: ['Sales', 'staff'],
        salesmgr: ['Sales', 'manager'],
        saleshead: ['Sales', 'head'],
        marketing: ['Marketing', 'staff'],
        marketingmgr: ['Marketing', 'manager'],
        marketinghead: ['Marketing', 'head'],
      });
      // The mirror-made membership keeps its role_keys; the seed only files it.
      expect(members.rows.find((m) => m.zitadel_user_id === zid('sales'))?.role_keys).toBeNull();
      expect(members.rows.find((m) => m.zitadel_user_id === zid('salesmgr'))?.role_keys).toEqual([
        'sales',
      ]);
      // Exactly one head per department: the triggers and the seed agree.
      const heads = await owner.query<{ name: string; n: string }>(
        `SELECT d.name, count(*) AS n FROM app.user_entities ue JOIN app.departments d ON d.id = ue.department_id
         WHERE ue.tenant_id = $1 AND ue.level = 'head' GROUP BY d.name ORDER BY d.name`,
        [scope.tenantId],
      );
      expect(heads.rows.map((r) => [r.name, Number(r.n)])).toEqual([
        ['Marketing', 1],
        ['Operations', 1],
        ['Sales', 1],
      ]);

      // CUST-DEV and the US customer (FX9, no PAN), with their 0191 country and address columns.
      const customers = await owner.query<{
        id: string;
        number: string;
        legal_name: string;
        name_norm: string;
        relationship: string;
        default_currency: string;
        owner_zid: string | null;
        pan_vat_no: string | null;
        country: string;
        address_line: string;
        address_city: string;
      }>(
        `SELECT c.id, c.number, c.legal_name, c.name_norm, c.relationship, c.default_currency,
                u.zitadel_user_id AS owner_zid, c.pan_vat_no, c.country, c.address_line, c.address_city
         FROM app.customers c
         LEFT JOIN app.users u ON u.id = c.owner_user_id
         WHERE c.tenant_id = $1
         ORDER BY c.number`,
        [scope.tenantId],
      );
      expect(customers.rows).toHaveLength(2);
      expect(customers.rows[0]).toMatchObject({
        number: DEV_CUSTOMER_PARTY_CODE,
        name_norm: DEV_CUSTOMER_NAME_NORM,
        relationship: 'active',
        default_currency: 'NPR',
        owner_zid: zid('sales'),
        country: 'NP',
        address_line: 'Durbar Marg 1',
        address_city: 'Kathmandu',
      });
      expect(customers.rows[1]).toMatchObject({
        number: DEV_FOREIGN_CUSTOMER.code,
        legal_name: DEV_FOREIGN_CUSTOMER.name,
        name_norm: DEV_FOREIGN_CUSTOMER.nameNorm,
        relationship: 'active',
        default_currency: 'USD',
        owner_zid: zid('sales'),
        pan_vat_no: null,
        country: 'US',
        address_line: DEV_FOREIGN_CUSTOMER.address.line,
        address_city: DEV_FOREIGN_CUSTOMER.address.city,
      });
      const contacts = await owner.query<{
        id: string;
        full_name: string;
        email_norm: string | null;
        is_primary: boolean;
        country: string;
      }>(
        `SELECT id, full_name, email_norm, is_primary, country FROM app.customer_contacts
         WHERE tenant_id = $1 ORDER BY full_name`,
        [scope.tenantId],
      );
      expect(contacts.rows).toHaveLength(2);
      expect(contacts.rows[1]).toMatchObject({
        full_name: DEV_FOREIGN_CUSTOMER.contact.name,
        email_norm: DEV_FOREIGN_CUSTOMER.contact.email,
        is_primary: true,
        country: 'US',
      });
      expect(contacts.rows[0]).toMatchObject({
        full_name: 'Dev Customer',
        email_norm: 'customer@dev.bos.test',
        is_primary: true,
        country: 'NP',
      });
      // Two numbers in two countries on the one contact (0192), the Nepal mobile primary.
      const phones = await owner.query<{
        contact_id: string;
        country: string;
        e164: string;
        label: string | null;
        sort_order: number;
        is_primary: boolean;
      }>(
        `SELECT contact_id, country, e164, label, sort_order, is_primary
         FROM app.customer_contact_phones WHERE tenant_id = $1 ORDER BY sort_order`,
        [scope.tenantId],
      );
      const contactId = contacts.rows[0]?.id;
      expect(phones.rows).toEqual([
        {
          contact_id: contactId,
          country: 'NP',
          e164: '+9779812345678',
          label: 'mobile',
          sort_order: 0,
          is_primary: true,
        },
        {
          contact_id: contactId,
          country: 'US',
          e164: '+14155552671',
          label: 'work',
          sort_order: 1,
          is_primary: false,
        },
      ]);
      const partyAccounts = await owner.query<{
        party_id: string;
        default_currency: string | null;
        term_code: string | null;
      }>(
        `SELECT pa.party_id, pa.default_currency, pt.code AS term_code
         FROM app.party_accounts pa
         LEFT JOIN app.payment_terms pt ON pt.id = pa.payment_term_id
         WHERE pa.tenant_id = $1 AND pa.organization_id = $2
         ORDER BY pa.default_currency`,
        [scope.tenantId, scope.organizationId],
      );
      expect(partyAccounts.rows).toEqual([
        { party_id: customers.rows[0]?.id, default_currency: 'NPR', term_code: 'NET30' },
        { party_id: customers.rows[1]?.id, default_currency: 'USD', term_code: 'NET30' },
      ]);

      // VEND-DEV (NP, 9-digit PAN) and the Indian vendor (foreign, loose tax id), each with an address and an account.
      const vendors = await owner.query<{
        legal_name: string;
        kind: string;
        pan: string | null;
        country: string;
        address_line: string | null;
        address_city: string | null;
        status: string;
        currency: string | null;
      }>(
        `SELECT v.legal_name, v.kind, v.pan, v.country, v.address_line, v.address_city, v.status,
                va.default_currency AS currency
         FROM app.vendors v
         LEFT JOIN app.vendor_accounts va
           ON va.tenant_id = v.tenant_id AND va.vendor_id = v.id AND va.organization_id = $2
         WHERE v.tenant_id = $1
           AND v.id NOT IN (SELECT id FROM app.parties WHERE tenant_id = $1 AND code = ANY($3::text[]))
         ORDER BY v.country DESC`,
        [scope.tenantId, scope.organizationId, EXTRA_VENDORS.map((v) => v.partyCode)],
      );
      expect(vendors.rows).toHaveLength(2);
      expect(vendors.rows[0]).toMatchObject({
        kind: 'company',
        pan: '123456789',
        country: 'NP',
        address_line: 'Teku Road 4',
        address_city: 'Kathmandu',
        status: 'approved',
        currency: 'NPR',
      });
      expect(vendors.rows[1]).toEqual({
        legal_name: DEV_FOREIGN_VENDOR.name,
        kind: 'foreign',
        pan: DEV_FOREIGN_VENDOR.pan,
        country: 'IN',
        address_line: DEV_FOREIGN_VENDOR.address.line,
        address_city: DEV_FOREIGN_VENDOR.address.city,
        status: 'approved',
        currency: 'INR',
      });

      // A re-run changes 0 rows, and no trigger writes behind the counts either.
      const audited = await auditCount(scope.tenantId);
      expect(await seed(scope, personas)).toBe(0);
      expect(await auditCount(scope.tenantId)).toBe(audited);
    },
    TEST_TIMEOUT,
  );
});

describe('company bank and expense accounts on Postgres', () => {
  it(
    'seeds the accounts with the retired ones retired, keeps rows made by hand, and a re-run writes nothing',
    async () => {
      const scope = await devTenant();
      // Made by hand before the seed: an "Operating account" at another bank, and 5200 under another name.
      await asFounder(scope, async (client) => {
        await client.query(
          `INSERT INTO app.company_bank_accounts (tenant_id, organization_id, name, bank_name, last4, currency)
           VALUES ($1, $2, 'Operating account', 'Hand Bank', '0001', 'INR')`,
          [scope.tenantId, scope.organizationId],
        );
        await client.query(
          `INSERT INTO app.expense_accounts (tenant_id, organization_id, code, name)
           VALUES ($1, $2, '5200', 'Office rent')`,
          [scope.tenantId, scope.organizationId],
        );
      });

      expect(await seed(scope)).toBeGreaterThan(0);

      const banks = await owner.query<{
        name: string;
        bank_name: string;
        last4: string;
        currency: string;
        status: string;
        retired: boolean;
      }>(
        `SELECT name, bank_name, last4, currency, status, retired_at IS NOT NULL AS retired
         FROM app.company_bank_accounts WHERE tenant_id = $1 AND organization_id = $2 ORDER BY name`,
        [scope.tenantId, scope.organizationId],
      );
      expect(banks.rows).toEqual([
        {
          name: 'Dollar account',
          bank_name: 'Standard Chartered Bank Nepal',
          last4: '7305',
          currency: 'USD',
          status: 'active',
          retired: false,
        },
        {
          name: 'Old payroll account',
          bank_name: 'Global IME Bank',
          last4: '1190',
          currency: 'NPR',
          status: 'retired',
          retired: true,
        },
        // The hand-made row wins: no second "Operating account", and its bank is untouched.
        {
          name: 'Operating account',
          bank_name: 'Hand Bank',
          last4: '0001',
          currency: 'INR',
          status: 'active',
          retired: false,
        },
      ]);

      const expenses = await owner.query<{
        code: string;
        name: string;
        status: string;
        retired: boolean;
      }>(
        `SELECT code, name, status, retired_at IS NOT NULL AS retired
         FROM app.expense_accounts WHERE tenant_id = $1 AND organization_id = $2 ORDER BY code`,
        [scope.tenantId, scope.organizationId],
      );
      expect(expenses.rows).toEqual([
        { code: '5100', name: 'Office supplies', status: 'active', retired: false },
        { code: '5200', name: 'Office rent', status: 'active', retired: false },
        { code: '5300', name: 'Utilities', status: 'active', retired: false },
        { code: '5400', name: 'Travel', status: 'active', retired: false },
        { code: '5500', name: 'Professional fees', status: 'active', retired: false },
        { code: '5800', name: 'Closed project costs', status: 'retired', retired: true },
        { code: '5900', name: 'Other expenses', status: 'active', retired: false },
      ]);

      // A re-run inserts nothing, and no audit row appears behind the count.
      const audited = await auditCount(scope.tenantId);
      expect(await seed(scope)).toBe(0);
      expect(await auditCount(scope.tenantId)).toBe(audited);
      const counts = await owner.query<{ banks: string; expenses: string }>(
        `SELECT (SELECT count(*) FROM app.company_bank_accounts WHERE tenant_id = $1) AS banks,
                (SELECT count(*) FROM app.expense_accounts WHERE tenant_id = $1) AS expenses`,
        [scope.tenantId],
      );
      expect([Number(counts.rows[0]?.banks), Number(counts.rows[0]?.expenses)]).toEqual([3, 7]);
    },
    TEST_TIMEOUT,
  );

  it(
    'seeds a fresh entity with two active and one retired bank account, six active and one retired expense account',
    async () => {
      const scope = await devTenant();
      // Fresh tenant: the first run writes all ten accounts among the kernel rows.
      expect(await seed(scope)).toBeGreaterThan(10);
      const summary = await owner.query<{ kind: string; status: string; n: string }>(
        `SELECT 'bank' AS kind, status, count(*) AS n FROM app.company_bank_accounts
           WHERE tenant_id = $1 AND organization_id = $2 GROUP BY status
         UNION ALL
         SELECT 'expense', status, count(*) FROM app.expense_accounts
           WHERE tenant_id = $1 AND organization_id = $2 GROUP BY status
         ORDER BY 1, 2`,
        [scope.tenantId, scope.organizationId],
      );
      expect(summary.rows.map((r) => [r.kind, r.status, Number(r.n)])).toEqual([
        ['bank', 'active', 2],
        ['bank', 'retired', 1],
        ['expense', 'active', 6],
        ['expense', 'retired', 1],
      ]);
      expect(await seed(scope)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe('reseed keeps Founder grants', () => {
  it(
    'leaves seeded = false grants and level rows alone, deletes only a seeded stale grant, and writes no level rows',
    async () => {
      const scope = await devTenant();
      await seed(scope);

      // Preconditions on the defaults the test leans on.
      expect(DEFAULT_ROLE_PERMISSIONS.sales['crm.lead.read']).toBe('own');
      const warehouse = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.warehouse));
      expect(warehouse.has('crm.lead.read')).toBe(false);
      expect(warehouse.has('crm.lead.write')).toBe(false);

      await asFounder(scope, async (client) => {
        // The Founder widened a default grant (Settings > Access saves it as their own row).
        await client.query(
          `UPDATE app.role_permissions SET scope = 'all', seeded = false
           WHERE tenant_id = $1 AND role_key = 'sales' AND permission = 'crm.lead.read'`,
          [scope.tenantId],
        );
        // The Founder added a grant the defaults do not have.
        await client.query(
          `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
           VALUES ($1, 'warehouse', 'crm.lead.read', 'own', false)`,
          [scope.tenantId],
        );
        // A seeded grant the defaults no longer list (an earlier seed wrote it).
        await client.query(
          `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
           VALUES ($1, 'warehouse', 'crm.lead.write', 'own', true)`,
          [scope.tenantId],
        );
        // The Founder's own level rule.
        await client.query(
          `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
           VALUES ($1, 'sales', 'crm.lead.read', 'manager', 'department', false)`,
          [scope.tenantId],
        );
      });

      // The stale seeded row goes (plus the authz bump); nothing else changes.
      expect(await seed(scope)).toBeGreaterThan(0);

      const grants = await owner.query<{
        role_key: string;
        permission: string;
        scope: string;
        seeded: boolean;
      }>(
        'SELECT role_key, permission, scope, seeded FROM app.role_permissions WHERE tenant_id = $1',
        [scope.tenantId],
      );
      const founderRows = grants.rows
        .filter((g) => !g.seeded)
        .map((g) => `${g.role_key}|${g.permission}|${g.scope}`)
        .sort();
      expect(founderRows).toEqual(['sales|crm.lead.read|all', 'warehouse|crm.lead.read|own']);
      expect(
        grants.rows.some((g) => g.role_key === 'warehouse' && g.permission === 'crm.lead.write'),
      ).toBe(false);

      // The seeded rows are exactly the current defaults, less the one the Founder now owns.
      const expected: string[] = [];
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        for (const [permission, grantScope] of Object.entries(defaults)) {
          if (role === 'sales' && permission === 'crm.lead.read') continue;
          expected.push(`${role}|${permission}|${grantScope}`);
        }
      }
      expect(
        grants.rows
          .filter((g) => g.seeded)
          .map((g) => `${g.role_key}|${g.permission}|${g.scope}`)
          .sort(),
      ).toEqual(expected.sort());

      // The seed never writes level rows: only the Founder's is there.
      const levels = await owner.query<{
        role_key: string;
        min_level: string;
        scope: string;
        seeded: boolean;
      }>(
        'SELECT role_key, min_level, scope, seeded FROM app.role_permission_levels WHERE tenant_id = $1',
        [scope.tenantId],
      );
      expect(levels.rows).toEqual([
        { role_key: 'sales', min_level: 'manager', scope: 'department', seeded: false },
      ]);

      // And the run after that is a no-op.
      expect(await seed(scope)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe('the extra dev vendors on Postgres (R6Q15)', () => {
  it(
    'makes vendor 2 approved and the vendor awaiting KYC pending_kyc with an editable KYB case, and a re-run changes nothing',
    async () => {
      const scope = await devTenant();
      const personas = personasFor(`pg-vendors-${randomUUID().slice(0, 8)}`);
      expect(await seed(scope, personas)).toBeGreaterThan(0);

      const rows = await owner.query<{
        code: string;
        status: string;
        pan: string;
        approved: boolean;
        has_account: boolean;
        case_status: string | null;
        checklist: { key: string; required: boolean; status: string }[] | null;
      }>(
        `SELECT p.code, v.status, v.pan, v.approved_by IS NOT NULL AS approved,
                EXISTS (SELECT 1 FROM app.vendor_accounts va
                        WHERE va.tenant_id = v.tenant_id AND va.vendor_id = v.id AND va.organization_id = $2) AS has_account,
                c.status AS case_status, c.checklist
         FROM app.vendors v
         JOIN app.parties p ON p.tenant_id = v.tenant_id AND p.id = v.id
         LEFT JOIN app.verification_cases c ON c.tenant_id = v.tenant_id AND c.party_id = v.id
         WHERE v.tenant_id = $1 AND p.code = ANY($3::text[])
         ORDER BY p.code`,
        [scope.tenantId, scope.organizationId, EXTRA_VENDORS.map((v) => v.partyCode)],
      );
      const bySeed = Object.fromEntries(rows.rows.map((r) => [r.code, r]));
      const approvedVendor = bySeed['VEND-DEV2'];
      const pendingVendor = bySeed['VEND-DEVKYC'];
      expect(approvedVendor).toMatchObject({
        status: 'approved',
        pan: '234567891',
        approved: true,
        has_account: true,
        case_status: null,
      });
      expect(pendingVendor).toMatchObject({
        status: 'pending_kyc',
        pan: '345678912',
        approved: false,
        has_account: true,
        case_status: 'draft',
      });
      const pan = pendingVendor?.checklist?.find((i) => i.key === 'pan_certificate');
      expect(pan).toMatchObject({ required: true, status: 'missing' });

      const audited = await auditCount(scope.tenantId);
      expect(await seed(scope, personas)).toBe(0);
      expect(await auditCount(scope.tenantId)).toBe(audited);
    },
    TEST_TIMEOUT,
  );

  it(
    'writes neither extra vendor when no dev personas are passed (the production path)',
    async () => {
      const scope = await devTenant();
      await seed(scope);
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.vendors v JOIN app.parties p ON p.tenant_id = v.tenant_id AND p.id = v.id
         WHERE v.tenant_id = $1 AND p.code = ANY($2::text[])`,
        [scope.tenantId, EXTRA_VENDORS.map((v) => v.partyCode)],
      );
      expect(Number(rows[0]?.n)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
