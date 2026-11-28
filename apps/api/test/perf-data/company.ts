import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DbHandle } from '@bos/db';

export class PerfDataError extends Error {}

export type Pool = DbHandle['pool'];
type PoolClient = NonNullable<Parameters<Parameters<Pool['connect']>[0]>[1]>;

// A separate tenant is necessary: audit hashes chain across all entities of a tenant.
export function perfId(key: string): string {
  const hex = createHash('sha256').update(`bos-perf-v1:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const scope = { tenantId: perfId('tenant'), organizationId: perfId('organization') };
export const staffOrg = perfId('staff-org');
export const staff = {
  accountant: perfId('accountant'),
  finance: perfId('finance'),
  founder: perfId('founder'),
  sales: perfId('sales'),
  procurement: perfId('procurement'),
  warehouse: perfId('warehouse'),
  management: perfId('management'),
};
export const vendor = perfId('vendor');
export const vat = perfId('vat');
export const expense = perfId('expense');
export const department = perfId('department');
export const customer = (n: number) => perfId(`customer-${n}`);

// A specifically named, local disposable database, never the normal `bos` database.
export function assertTarget(url: string, mode: string | undefined): void {
  const parsed = new URL(url);
  if (
    !['development', 'test'].includes(mode ?? '') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !/^\/(bos_perf(?:_[a-z0-9_]+)?|bos_t_[a-f0-9]+)$/.test(parsed.pathname)
  ) {
    throw new PerfDataError(
      'Perf data requires NODE_ENV=development or test and a local bos_perf[_...] or bos_t_... database',
    );
  }
}

const dbPattern = /^(bos_perf(?:_[a-z0-9_]+)?|bos_t_[a-f0-9]+)$/;

export async function ensureStorageRoot(pool: Pool, root: string): Promise<void> {
  // Bind the storage root to this exact database/cluster; another perf DB uses the same deterministic tenant ID.
  const { rows } = await pool.query<{ identity: string }>(
    `SELECT current_database() || ':' || d.oid || ':' || s.system_identifier AS identity FROM pg_database d CROSS JOIN pg_control_system() s WHERE d.datname=current_database()`,
  );
  const identity = rows[0]!.identity;
  if (!dbPattern.test(identity.split(':')[0]!))
    throw new PerfDataError('Not a disposable perf database');
  await mkdir(root, { recursive: true });
  const marker = join(root, '.bos-perf-database');
  try {
    await writeFile(marker, identity, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(marker, 'utf8')) !== identity)
      throw new PerfDataError('Perf storage root belongs to a different database');
  }
}

export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ name: string }>('SELECT current_database() AS name');
    if (!dbPattern.test(rows[0]!.name)) throw new PerfDataError('Not a disposable perf database');
    await c.query(
      `SELECT set_config('bos.tenant_id',$1,true), set_config('bos.organization_id',$2,true), set_config('bos.actor_kind','seed',true), set_config('bos.actor_id','perf-seed',true), set_config('bos.correlation_id','perf-seed',true), set_config('bos.ip','',true), set_config('bos.user_agent','',true)`,
      [scope.tenantId, scope.organizationId],
    );
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function assertCompany(c: PoolClient): Promise<boolean> {
  const { rows } = await c.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM app.organizations WHERE tenant_id=$1 OR id=$2',
    [scope.tenantId, scope.organizationId],
  );
  const exists = await c.query('SELECT 1 FROM app.tenants WHERE id=$1', [scope.tenantId]);
  if (!exists.rowCount && rows.length === 0) return false;
  if (
    rows.length !== 1 ||
    rows[0]?.id !== scope.organizationId ||
    rows[0].code !== 'PERF' ||
    rows[0].name !== 'Perf (disposable test data)'
  )
    throw new PerfDataError('Perf company identity mismatch; refusing to write or clean up');
  return true;
}

export async function createCompany(pool: Pool, customers: number): Promise<void> {
  await transaction(pool, async (c) => {
    await assertCompany(c);
    const t = scope.tenantId,
      o = scope.organizationId;
    await c.query('INSERT INTO app.tenants (id) VALUES ($1) ON CONFLICT DO NOTHING', [t]);
    await c.query(
      `INSERT INTO app.organizations (id,tenant_id,organization_id,code,name,legal_name,is_default) VALUES ($1,$2,$1,'PERF','Perf (disposable test data)','Perf Test Company',true) ON CONFLICT DO NOTHING`,
      [o, t],
    );
    await c.query(
      `INSERT INTO app.idp_orgs (id,tenant_id,zitadel_org_id,kind,name) VALUES ($1,$2,'perf-db-only','staff','Perf staff') ON CONFLICT DO NOTHING`,
      [staffOrg, t],
    );
    await c.query(
      `INSERT INTO app.departments (id,tenant_id,organization_id,name) VALUES ($1,$2,$3,'Perf team') ON CONFLICT DO NOTHING`,
      [department, t, o],
    );
    for (const [role, id] of Object.entries(staff)) {
      await c.query(
        `INSERT INTO app.users (id,tenant_id,idp_org_id,zitadel_user_id,email,display_name,status) VALUES ($1,$2,$3,$4,$5,$6,'active') ON CONFLICT DO NOTHING`,
        [id, t, staffOrg, `perf-db-only-${role}`, `${role}@perf.invalid`, `Perf ${role}`],
      );
      await c.query(
        `INSERT INTO app.user_entities (tenant_id,organization_id,user_id,is_default,department_id) VALUES ($1,$2,$3,true,$4) ON CONFLICT DO NOTHING`,
        [t, o, id, department],
      );
      await c.query(
        `INSERT INTO app.user_roles (tenant_id,user_id,role_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [t, id, role],
      );
    }
    await c.query(
      `INSERT INTO app.user_roles (tenant_id,user_id,role_key) VALUES ($1,$2,'accountant') ON CONFLICT DO NOTHING`,
      [t, staff.management],
    );
    for (const role of ['accountant', 'finance', 'founder'] as const) {
      const groupId = perfId(`group-${role}`);
      await c.query(
        `INSERT INTO app.approval_groups (id, tenant_id,organization_id,key,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [groupId, t, o, `perf-${role}`, `Perf ${role}`],
      );
      await c.query(
        `INSERT INTO app.approval_group_members (tenant_id,organization_id,group_id,user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [t, o, groupId, staff[role]],
      );
    }
    for (let n = 0; n < customers; n++) {
      const id = customer(n),
        code = `PERF-CUSTOMER-${n + 1}`,
        name = `Perf Customer ${n + 1}`;
      await c.query(
        `INSERT INTO app.parties (id,tenant_id,kind,code,name) VALUES ($1,$2,'customer',$3,$4) ON CONFLICT DO NOTHING`,
        [id, t, code, name],
      );
      await c.query(
        `INSERT INTO app.customers (id,tenant_id,number,legal_name,name_norm,relationship,owner_user_id,default_currency,country,address_line,address_city) VALUES ($1,$2,$3,$4,lower($4),'active',$5,'NPR','NP','Test address','Kathmandu') ON CONFLICT DO NOTHING`,
        [id, t, code, name, staff.sales],
      );
      await c.query(
        `INSERT INTO app.party_accounts (tenant_id,organization_id,party_id,owner_user_id,default_currency) VALUES ($1,$2,$3,$4,'NPR') ON CONFLICT DO NOTHING`,
        [t, o, id, staff.sales],
      );
      const portalOrg = perfId(`portal-org-${n}`);
      await c.query(
        `INSERT INTO app.idp_orgs (id,tenant_id,zitadel_org_id,kind,party_id,name) VALUES ($1,$2,$3,'customer',$4,$5) ON CONFLICT DO NOTHING`,
        [portalOrg, t, `perf-db-only-customer-${n}`, id, name],
      );
      await c.query(
        `INSERT INTO app.users (id,tenant_id,idp_org_id,zitadel_user_id,email,display_name,status) VALUES ($1,$2,$3,$4,$5,$6,'active') ON CONFLICT DO NOTHING`,
        [
          perfId(`portal-user-${n}`),
          t,
          portalOrg,
          `perf-db-only-portal-${n}`,
          `customer${n}@perf.invalid`,
          name,
        ],
      );
    }
    await c.query(
      `INSERT INTO app.parties (id,tenant_id,kind,code,name) VALUES ($1,$2,'vendor','PERF-VEND','Perf Vendor') ON CONFLICT DO NOTHING`,
      [vendor, t],
    );
    await c.query(
      `INSERT INTO app.vendors (id,tenant_id,legal_name,kind,pan,vat_registered,country,address_line,address_city,status,created_by,approved_by) VALUES ($1,$2,'Perf Vendor','company','123456789',false,'NP','Test address','Kathmandu','approved',$3,$4) ON CONFLICT DO NOTHING`,
      [vendor, t, staff.procurement, staff.founder],
    );
    await c.query(
      `INSERT INTO app.vendor_accounts (tenant_id,organization_id,vendor_id,default_currency) VALUES ($1,$2,$3,'NPR') ON CONFLICT DO NOTHING`,
      [t, o, vendor],
    );
    await c.query(
      `INSERT INTO app.tax_codes (id,tenant_id,code,name,kind,rate_bp,creditable,effective_from) VALUES ($1,$2,'PERF-VAT','VAT 13%', 'vat',1300,true,'2020-01-01') ON CONFLICT DO NOTHING`,
      [vat, t],
    );
    await c.query(
      `INSERT INTO app.expense_accounts (id,tenant_id,organization_id,code,name,status) VALUES ($1,$2,$3,'PERF','Perf expense','active') ON CONFLICT DO NOTHING`,
      [expense, t, o],
    );
  });
}

export async function crm(pool: Pool, leads: number, activities: number): Promise<void> {
  await transaction(pool, async (c) => {
    if (!(await assertCompany(c))) throw new PerfDataError('Create the perf company first');
    const t = scope.tenantId,
      o = scope.organizationId;
    await c.query(
      `INSERT INTO app.leads (id,tenant_id,organization_id,number,title,source,owner_user_id,created_by_user_id,company_name,contact_name)
      SELECT md5($1::text || ':lead:' || n)::uuid,$1::uuid,$2,'PERF-L-'||n,'Perf Lead '||n,'website',$3,$3,'Test Company '||n,'Test Contact '||n FROM generate_series(1,$4::int) n ON CONFLICT DO NOTHING`,
      [t, o, staff.sales, leads],
    );
    await c.query(
      `INSERT INTO app.activities (id,tenant_id,organization_id,kind,subject,lead_id,created_by_user_id,occurred_at)
      SELECT md5($1::text || ':activity:' || n)::uuid,$1::uuid,$2,'note','Perf activity '||n,md5($1::text || ':lead:' || (1+(n-1)%$3::int))::uuid,$4,now() - n*interval '1 minute' FROM generate_series(1,$5::int) n ON CONFLICT DO NOTHING`,
      [t, o, leads, staff.sales, activities],
    );
  });
}
