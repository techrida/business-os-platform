// Tests for the counterparty-column rule of check-tenancy (ADR 0017): customer_organization_id and
// vendor_organization_id must be a nullable uuid, with a foreign key to app.organizations and an index that
// leads with tenant_id. (The base tenant_id / organization_id rule is tested in db.test.ts.)
//
// Needs Docker: a bare postgres:16-alpine from Testcontainers. Each case builds a tiny `app` schema inside a
// transaction and rolls it back, so nothing leaks between cases and no migration has to run.
// Run with: pnpm --filter @bos/db exec vitest run src/check-tenancy.test.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkTenancy, describeViolations } from './check-tenancy.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// The two tables every fixture needs. app.tenants is allowlisted by default; app.organizations carries the
// two tenancy columns and, having no counterparty column, is not subject to the rule.
const BASE = `
  CREATE SCHEMA app;
  CREATE TABLE app.tenants (id uuid PRIMARY KEY);
  CREATE TABLE app.organizations (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL
  );`;

/** Creates the base tables plus `fixtureSql`, runs checkTenancy, rolls everything back. */
async function check(fixtureSql: string, options?: Parameters<typeof checkTenancy>[1]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(BASE);
    await client.query(fixtureSql);
    return await checkTenancy(client, options);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** A document table with the two tenancy columns plus whatever `body` adds. */
const docs = (body: string) => `
  CREATE TABLE app.docs (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    ${body}
  );`;

describe('counterparty columns: a well-formed fixture passes', () => {
  it('accepts a nullable uuid FK to app.organizations with a (tenant_id, column) index', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid REFERENCES app.organizations (id)`) +
        'CREATE INDEX docs_customer_idx ON app.docs (tenant_id, customer_organization_id);',
    );
    expect(violations).toEqual([]);
  });

  it('accepts the vendor column, and a table with both columns', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid REFERENCES app.organizations (id),
            vendor_organization_id uuid REFERENCES app.organizations (id)`) +
        `CREATE INDEX docs_customer_idx ON app.docs (tenant_id, customer_organization_id);
         CREATE INDEX docs_vendor_idx ON app.docs (tenant_id, vendor_organization_id);`,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a longer tenant-leading index that contains the column', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid REFERENCES app.organizations (id)`) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, organization_id, customer_organization_id);',
    );
    expect(violations).toEqual([]);
  });

  it('does not apply to tables without a counterparty column', async () => {
    expect(await check(docs('title text'))).toEqual([]);
  });
});

describe('counterparty columns: a malformed fixture fails', () => {
  const GOOD_INDEX = 'CREATE INDEX docs_idx ON app.docs (tenant_id, customer_organization_id);';
  const FK = 'REFERENCES app.organizations (id)';

  it('fails when the column is NOT NULL', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid NOT NULL ${FK}`) + GOOD_INDEX,
    );
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_organization_id', problem: 'not nullable' },
    ]);
  });

  it('fails when the column is not a uuid', async () => {
    const violations = await check(docs('customer_organization_id text') + GOOD_INDEX);
    const problems = violations.map((v) => v.problem);
    expect(problems).toContain('not uuid');
    // A text column cannot reference a uuid key, so the missing FK is reported too.
    expect(problems).toContain('no foreign key to app.organizations');
  });

  it('fails when there is no foreign key', async () => {
    const violations = await check(docs('customer_organization_id uuid') + GOOD_INDEX);
    expect(violations).toEqual([
      {
        table: 'app.docs',
        column: 'customer_organization_id',
        problem: 'no foreign key to app.organizations',
      },
    ]);
  });

  it('fails when the foreign key points at another table', async () => {
    const violations = await check(
      docs('customer_organization_id uuid REFERENCES app.tenants (id)') + GOOD_INDEX,
    );
    expect(violations.map((v) => v.problem)).toEqual(['no foreign key to app.organizations']);
  });

  it('fails when there is no index at all', async () => {
    const violations = await check(docs(`customer_organization_id uuid ${FK}`));
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_organization_id', problem: 'no tenant-leading index' },
    ]);
  });

  it('fails when the only index is on tenant_id alone', async () => {
    // It leads with tenant_id, but it does not contain the column, so the portal filter cannot use it.
    const violations = await check(
      docs(`customer_organization_id uuid ${FK}`) +
        'CREATE INDEX docs_tenant_idx ON app.docs (tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index does not lead with tenant_id', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid ${FK}`) +
        'CREATE INDEX docs_idx ON app.docs (customer_organization_id, tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index is partial', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid ${FK}`) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, customer_organization_id) WHERE organization_id IS NOT NULL;',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('reports the vendor column by its own name', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid ${FK}, vendor_organization_id uuid`) + GOOD_INDEX,
    );
    expect(violations.map((v) => [v.column, v.problem])).toEqual([
      ['vendor_organization_id', 'no foreign key to app.organizations'],
      ['vendor_organization_id', 'no tenant-leading index'],
    ]);
  });

  it('skips an allowlisted table', async () => {
    const violations = await check(docs('customer_organization_id uuid'), {
      allowlist: ['app.tenants', 'app.docs'],
    });
    expect(violations).toEqual([]);
  });

  it('names the table, the column and the rule in the message', async () => {
    const violations = await check(docs('customer_organization_id uuid NOT NULL'));
    const message = describeViolations(violations);
    expect(message).toContain('app.docs.customer_organization_id: not nullable');
    expect(message).toContain('nullable uuid with a foreign key to app.organizations');
  });
});
