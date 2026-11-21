// SQL fixture helpers for tests (ADR 0027): a tenant with its default legal entity, parties with their IdP orgs,
// staff and portal users. They replace the raw `INSERT INTO app.organizations ... kind` that tests used before an
// organization became a legal entity, so a test says what it needs and the schema can change in one place.
//
// Every helper runs in its own transaction on a connection of the pool it is given and sets the bos.* audit
// context first (the same settings withTx() sets), so the audit triggers accept the writes. Tenant-scoped rows
// (parties, idp_orgs, users, user_roles) are audited under bos.organization_id, so helpers that need an acting
// entity take it from the arguments, or use the tenant's default entity.
// Codes and ids are random unless given, so a test can call a helper twice without a collision.
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

/** Anything that hands out a connection: a Pool, or a test's own wrapper. */
export type FixturePool = Pick<Pool, 'connect'>;

/** The actor the helpers write as. Visible in audit.audit_events, so a test can tell fixture rows apart. */
const ACTOR_ID = 'system:test-fixtures';

/** A short random suffix for generated codes and ZITADEL ids. */
function suffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 10);
}

/** Runs fn in one transaction, after set_config(..., true) of the bos.* settings (like withTx). */
async function inFixtureTx<T>(
  pool: FixturePool,
  scope: { tenantId?: string; organizationId?: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settings: Record<string, string> = {
      'bos.actor_kind': 'system',
      'bos.actor_id': ACTOR_ID,
      'bos.correlation_id': `fixture:${randomUUID()}`,
      'bos.ip': '',
      'bos.user_agent': '',
      ...(scope.tenantId === undefined ? {} : { 'bos.tenant_id': scope.tenantId }),
      ...(scope.organizationId === undefined
        ? {}
        : { 'bos.organization_id': scope.organizationId }),
    };
    for (const [key, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [key, value]);
    }
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

/** The id of the tenant's default entity, or a clear error (better than the audit trigger's RAISE). */
async function defaultEntityOf(client: PoolClient, tenantId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM app.organizations WHERE tenant_id = $1 AND is_default',
    [tenantId],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `fixtures: tenant ${tenantId} has no default entity; create it with createTenantWithEntity()`,
    );
  }
  return id;
}

export interface TenantWithEntity {
  tenantId: string;
  /** The default legal entity. Its organization_id equals its id. */
  organizationId: string;
  /** The staff IdP org (the login container of every staff user of the tenant). */
  idpOrgId: string;
}

/** A tenant, its default legal entity and its staff IdP org. */
export async function createTenantWithEntity(
  pool: FixturePool,
  options: { code?: string; name?: string } = {},
): Promise<TenantWithEntity> {
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  const idpOrgId = randomUUID();
  const code = options.code ?? `E${suffix()}`;
  const name = options.name ?? `Entity ${code}`;
  await inFixtureTx(pool, { tenantId, organizationId }, async (client) => {
    await client.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
    await client.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
       VALUES ($1, $2, $1, $3, $4, $4, true)`,
      [organizationId, tenantId, code, name],
    );
    await client.query(
      `INSERT INTO app.idp_orgs (id, tenant_id, zitadel_org_id, kind, name)
       VALUES ($1, $2, $3, 'staff', $4)`,
      [idpOrgId, tenantId, `fixture-staff-${suffix()}`, `${name} staff`],
    );
  });
  return { tenantId, organizationId, idpOrgId };
}

export interface Party {
  partyId: string;
  /** The IdP org (login container) of this party's portal users. */
  idpOrgId: string;
}

/**
 * A customer or vendor party and the IdP org of the same kind behind it. The writes are audited under the
 * tenant's default entity, or `organizationId` when given.
 */
export async function createParty(
  pool: FixturePool,
  options: {
    tenantId: string;
    kind: 'customer' | 'vendor';
    code?: string;
    organizationId?: string;
  },
): Promise<Party> {
  const { tenantId, kind } = options;
  const partyId = randomUUID();
  const idpOrgId = randomUUID();
  const code = options.code ?? `P${suffix()}`;
  // Look the entity up first: an unset bos.organization_id would make the audit trigger RAISE.
  return inFixtureTx(pool, { tenantId }, async (client) => {
    const organizationId = options.organizationId ?? (await defaultEntityOf(client, tenantId));
    await client.query('SELECT set_config($1, $2, true)', ['bos.organization_id', organizationId]);
    await client.query(
      'INSERT INTO app.parties (id, tenant_id, kind, code, name) VALUES ($1, $2, $3, $4, $5)',
      [partyId, tenantId, kind, code, `${kind} ${code}`],
    );
    await client.query(
      `INSERT INTO app.idp_orgs (id, tenant_id, zitadel_org_id, kind, party_id, name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [idpOrgId, tenantId, `fixture-${kind}-${suffix()}`, kind, partyId, `${kind} ${code} login`],
    );
    return { partyId, idpOrgId };
  });
}

/** A department of one legal entity (departments belong to an entity, not to the tenant). */
export async function createDepartment(
  pool: FixturePool,
  options: { tenantId: string; organizationId: string; name?: string },
): Promise<{ departmentId: string }> {
  const { tenantId, organizationId } = options;
  const departmentId = randomUUID();
  await inFixtureTx(pool, { tenantId, organizationId }, async (client) => {
    await client.query(
      'INSERT INTO app.departments (id, tenant_id, organization_id, name) VALUES ($1, $2, $3, $4)',
      [departmentId, tenantId, organizationId, options.name ?? `Dept ${suffix()}`],
    );
  });
  return { departmentId };
}

/** INSERT of an active user; returns its id. The ZITADEL id is random, so users never collide. */
async function insertUser(
  client: PoolClient,
  tenantId: string,
  idpOrgId: string,
  prefix: string,
): Promise<string> {
  const userId = randomUUID();
  const tag = suffix();
  await client.query(
    `INSERT INTO app.users (id, tenant_id, idp_org_id, zitadel_user_id, email, display_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
    [
      userId,
      tenantId,
      idpOrgId,
      `fixture-${prefix}-${tag}`,
      `${prefix}-${tag}@example.test`,
      `${prefix} ${tag}`,
    ],
  );
  return userId;
}

/**
 * An active staff user under the staff IdP org, with one default membership in `organizationId` (role_keys NULL:
 * every token role) and one user_roles row per entry of roleKeys. A bad argument (say a department of another
 * entity) rolls the whole user back.
 */
export async function createStaffUser(
  pool: FixturePool,
  options: {
    tenantId: string;
    organizationId: string;
    idpOrgId: string;
    roleKeys?: readonly string[];
    departmentId?: string;
  },
): Promise<{ userId: string }> {
  const { tenantId, organizationId, idpOrgId } = options;
  const userId = await inFixtureTx(pool, { tenantId, organizationId }, async (client) => {
    const id = await insertUser(client, tenantId, idpOrgId, 'staff');
    await client.query(
      `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, department_id)
       VALUES ($1, $2, $3, true, $4)`,
      [tenantId, organizationId, id, options.departmentId ?? null],
    );
    for (const roleKey of options.roleKeys ?? []) {
      await client.query(
        'INSERT INTO app.user_roles (tenant_id, user_id, role_key) VALUES ($1, $2, $3)',
        [tenantId, id, roleKey],
      );
    }
    return id;
  });
  return { userId };
}

/**
 * An active portal user under a customer or vendor IdP org (see createParty). Portal users have no membership:
 * the request's entity falls back to the tenant's default entity, which is also what the write is audited under.
 */
export async function createPortalUser(
  pool: FixturePool,
  options: { tenantId: string; idpOrgId: string },
): Promise<{ userId: string }> {
  const { tenantId, idpOrgId } = options;
  const userId = await inFixtureTx(pool, { tenantId }, async (client) => {
    const organizationId = await defaultEntityOf(client, tenantId);
    await client.query('SELECT set_config($1, $2, true)', ['bos.organization_id', organizationId]);
    return insertUser(client, tenantId, idpOrgId, 'portal');
  });
  return { userId };
}

/** A cost centre of one legal entity, audited under the fixture system actor. */
export async function createCostCenter(
  pool: FixturePool,
  options: {
    tenantId: string;
    organizationId: string;
    code?: string;
    name?: string;
    active?: boolean;
  },
): Promise<{ costCenterId: string }> {
  const costCenterId = randomUUID();
  await inFixtureTx(pool, options, async (client) => {
    await client.query(
      `INSERT INTO app.cost_centers (id, tenant_id, organization_id, code, name, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        costCenterId,
        options.tenantId,
        options.organizationId,
        options.code ?? `CC-${suffix()}`,
        options.name ?? 'Fixture cost centre',
        options.active ?? true,
      ],
    );
  });
  return { costCenterId };
}

/** A retired row needs both columns (the retired_at check), so `status: 'retired'` stamps retired_at too. */
function retiredAtFor(status: 'active' | 'retired', retiredAt: Date | undefined): Date | null {
  if (status === 'active') return null;
  return retiredAt ?? new Date();
}

export interface CompanyBankAccountRow {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  bankName: string;
  last4: string;
  currency: string;
  status: 'active' | 'retired';
  retiredAt: Date | null;
}

/** A bank account of one legal entity (0143), audited under the fixture system actor. Returns the stored row. */
export async function createCompanyBankAccount(
  pool: FixturePool,
  options: {
    tenantId: string;
    organizationId: string;
    name?: string;
    bankName?: string;
    last4?: string;
    currency?: string;
    status?: 'active' | 'retired';
    retiredAt?: Date;
  },
): Promise<CompanyBankAccountRow> {
  const status = options.status ?? 'active';
  return inFixtureTx(pool, options, async (client) => {
    const { rows } = await client.query<CompanyBankAccountRow>(
      `INSERT INTO app.company_bank_accounts
         (tenant_id, organization_id, name, bank_name, last4, currency, status, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tenant_id AS "tenantId", organization_id AS "organizationId", name,
         bank_name AS "bankName", last4, currency, status, retired_at AS "retiredAt"`,
      [
        options.tenantId,
        options.organizationId,
        options.name ?? 'Fixture operating account',
        options.bankName ?? 'Fixture Bank',
        options.last4 ?? '1234',
        options.currency ?? 'NPR',
        status,
        retiredAtFor(status, options.retiredAt),
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixtures: company bank account insert returned no row');
    return row;
  });
}

export interface ExpenseAccountRow {
  id: string;
  tenantId: string;
  organizationId: string;
  code: string;
  name: string;
  status: 'active' | 'retired';
  retiredAt: Date | null;
}

/** An expense account of one legal entity (0144), audited under the fixture system actor. Returns the stored row. */
export async function createExpenseAccount(
  pool: FixturePool,
  options: {
    tenantId: string;
    organizationId: string;
    code?: string;
    name?: string;
    status?: 'active' | 'retired';
    retiredAt?: Date;
  },
): Promise<ExpenseAccountRow> {
  const status = options.status ?? 'active';
  return inFixtureTx(pool, options, async (client) => {
    const { rows } = await client.query<ExpenseAccountRow>(
      `INSERT INTO app.expense_accounts (tenant_id, organization_id, code, name, status, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id AS "tenantId", organization_id AS "organizationId", code, name, status,
         retired_at AS "retiredAt"`,
      [
        options.tenantId,
        options.organizationId,
        options.code ?? `EX-${suffix()}`,
        options.name ?? 'Fixture expense account',
        status,
        retiredAtFor(status, options.retiredAt),
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixtures: expense account insert returned no row');
    return row;
  });
}
