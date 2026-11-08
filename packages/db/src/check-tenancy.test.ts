// Tests for two rule sets of check-tenancy. (The base tenant_id / organization_id rule is tested in db.test.ts.)
//  1. The counterparty-column rule (ADR 0017): customer_organization_id and vendor_organization_id must be a
//     nullable uuid, with a foreign key to app.organizations and an index that leads with tenant_id.
//  2. The tenant-integrity rules (review finding R17), read from pg_constraint. Rule 1 (tenant_id references
//     tenants) is always on. Rule 2 (organization_id references organizations), rule 3 (every other foreign key
//     to a tenant-owned table carries tenant_id) and rule 4 (every UNIQUE / PRIMARY KEY other than one on id
//     alone leads with tenant_id) are opt-in through requireCompositeTenancy, so their tests pass it.
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

// The two tables every fixture needs. app.tenants is allowlisted by default; app.organizations is itself a
// well-formed tenant-owned table (tenant FK, self FK for organization_id, UNIQUE (tenant_id, id) so that
// composite foreign keys can point at it), so it adds no violation of its own.
const BASE = `
  CREATE SCHEMA app;
  CREATE TABLE app.tenants (id uuid PRIMARY KEY);
  CREATE TABLE app.organizations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    organization_id uuid NOT NULL REFERENCES app.organizations (id),
    UNIQUE (tenant_id, id)
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

/**
 * A well-formed document table: the two tenancy columns, the tenant and organization foreign keys, and
 * UNIQUE (tenant_id, id) as a target for composite foreign keys. `body` adds columns and constraints.
 */
const docs = (body: string) => `
  CREATE TABLE app.docs (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    ${body},
    FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),
    UNIQUE (tenant_id, id)
  );`;

/** A foreign key from a counterparty column to app.organizations, scoped by tenant like every other one. */
const cpFk = (column: string) =>
  `FOREIGN KEY (tenant_id, ${column}) REFERENCES app.organizations (tenant_id, id)`;

/** A table with the two tenancy columns and NO constraints beyond `body`: the starting point for rules 1 and 2. */
const bare = (body: string) => `
  CREATE TABLE app.bare (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    ${body}
  );`;

/** A child of app.docs with its own tenant and organization foreign keys; `body` adds the rest (the rule under test). */
const lines = (body: string) => `
  CREATE TABLE app.lines (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    doc_id uuid NOT NULL, n int NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),
    ${body}
  );`;

describe('counterparty columns: a well-formed fixture passes', () => {
  it('accepts a nullable uuid FK to app.organizations with a (tenant_id, column) index', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, ${cpFk('customer_organization_id')}`) +
        'CREATE INDEX docs_customer_idx ON app.docs (tenant_id, customer_organization_id);',
    );
    expect(violations).toEqual([]);
  });

  it('accepts the vendor column, and a table with both columns', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, vendor_organization_id uuid,
            ${cpFk('customer_organization_id')}, ${cpFk('vendor_organization_id')}`) +
        `CREATE INDEX docs_customer_idx ON app.docs (tenant_id, customer_organization_id);
         CREATE INDEX docs_vendor_idx ON app.docs (tenant_id, vendor_organization_id);`,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a longer tenant-leading index that contains the column', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, ${cpFk('customer_organization_id')}`) +
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
  const CUSTOMER_FK = cpFk('customer_organization_id');

  it('fails when the column is NOT NULL', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid NOT NULL, ${CUSTOMER_FK}`) + GOOD_INDEX,
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
    const violations = await check(docs(`customer_organization_id uuid, ${CUSTOMER_FK}`));
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_organization_id', problem: 'no tenant-leading index' },
    ]);
  });

  it('fails when the only index is on tenant_id alone', async () => {
    // It leads with tenant_id, but it does not contain the column, so the portal filter cannot use it.
    const violations = await check(
      docs(`customer_organization_id uuid, ${CUSTOMER_FK}`) +
        'CREATE INDEX docs_tenant_idx ON app.docs (tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index does not lead with tenant_id', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, ${CUSTOMER_FK}`) +
        'CREATE INDEX docs_idx ON app.docs (customer_organization_id, tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index is partial', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, ${CUSTOMER_FK}`) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, customer_organization_id) WHERE organization_id IS NOT NULL;',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('reports the vendor column by its own name', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid, ${CUSTOMER_FK}, vendor_organization_id uuid`) +
        GOOD_INDEX,
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

// Tenant integrity (R17). The rules read pg_constraint, so a fixture names its constraint explicitly wherever the
// test is about one, and never relies on what Postgres would call it.
const STRICT = { requireCompositeTenancy: true };

describe('tenant integrity: a well-formed fixture passes', () => {
  it('accepts tenant FK, organization FK, composite parent FK and tenant-leading uniques', async () => {
    const fixture =
      // ops.regions has no tenant_id, so a plain foreign key to it is not subject to rule 3.
      `CREATE SCHEMA ops; CREATE TABLE ops.regions (id uuid PRIMARY KEY);` +
      docs('title text') +
      lines(`region_id uuid REFERENCES ops.regions (id),
             FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id),
             UNIQUE (tenant_id, doc_id, n)`);
    expect(await check(fixture)).toEqual([]);
    expect(await check(fixture, STRICT)).toEqual([]);
  });

  it('accepts a single-column organization_id foreign key (rule 2 allows either shape)', async () => {
    const violations = await check(
      bare(`FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
            FOREIGN KEY (organization_id) REFERENCES app.organizations (id)`),
      STRICT,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a composite primary key that leads with tenant_id', async () => {
    const violations = await check(
      `CREATE TABLE app.members (
         tenant_id uuid NOT NULL, organization_id uuid NOT NULL, user_id uuid NOT NULL,
         PRIMARY KEY (tenant_id, user_id),
         FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
         FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id)
       );`,
    );
    expect(violations).toEqual([]);
  });
});

describe('tenant integrity: a malformed fixture fails', () => {
  it('rule 1: fails when tenant_id has no foreign key to app.tenants', async () => {
    const violations = await check(
      bare('FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id)'),
    );
    expect(violations).toEqual([
      { table: 'app.bare', column: 'tenant_id', problem: 'no foreign key to app.tenants' },
    ]);
  });

  it('rule 2: fails when organization_id has no foreign key to app.organizations', async () => {
    const violations = await check(
      bare('FOREIGN KEY (tenant_id) REFERENCES app.tenants (id)'),
      STRICT,
    );
    expect(violations).toEqual([
      {
        table: 'app.bare',
        column: 'organization_id',
        problem: 'no foreign key to app.organizations from organization_id',
      },
    ]);
  });

  it('rule 3: fails when a foreign key to a tenant-owned table does not include tenant_id', async () => {
    const violations = await check(
      docs('title text') +
        lines('CONSTRAINT lines_doc_fk FOREIGN KEY (doc_id) REFERENCES app.docs (id)'),
      STRICT,
    );
    expect(violations).toEqual([
      {
        table: 'app.lines',
        column: 'doc_id',
        constraint: 'lines_doc_fk',
        problem: 'foreign key not scoped by tenant_id',
      },
    ]);
  });

  it('rule 3: fails when tenant_id is in the foreign key but paired with the wrong parent column', async () => {
    // Postgres accepts this: the parent's UNIQUE (tenant_id, id) covers the column set {id, tenant_id}, in any order.
    const violations = await check(
      docs('title text') +
        lines(
          'CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (id, tenant_id)',
        ),
      STRICT,
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['lines_doc_fk', 'foreign key not scoped by tenant_id'],
    ]);
  });

  it('rule 3: a single-column counterparty foreign key satisfies ADR 0017 but is flagged here', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid,
            CONSTRAINT docs_customer_fk FOREIGN KEY (customer_organization_id) REFERENCES app.organizations (id)`) +
        'CREATE INDEX docs_customer_idx ON app.docs (tenant_id, customer_organization_id);',
      STRICT,
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['docs_customer_fk', 'foreign key not scoped by tenant_id'],
    ]);
  });

  it('rule 4: fails when a UNIQUE constraint does not lead with tenant_id', async () => {
    const violations = await check(
      docs('title text') +
        lines(`FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id),
               CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n)`),
      STRICT,
    );
    expect(violations).toEqual([
      {
        table: 'app.lines',
        column: 'doc_id, n',
        constraint: 'lines_doc_n_unique',
        problem: 'unique key does not lead with tenant_id',
      },
    ]);
  });

  it('rule 4: fails when tenant_id is in the key but not first, or a PRIMARY KEY is not on id', async () => {
    const violations = await check(
      `CREATE TABLE app.keyed (
         tenant_id uuid NOT NULL, organization_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
         CONSTRAINT keyed_pk PRIMARY KEY (user_id, tenant_id),
         CONSTRAINT keyed_role_unique UNIQUE (role, tenant_id),
         FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
         FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id)
       );`,
      STRICT,
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['keyed_pk', 'unique key does not lead with tenant_id'],
      ['keyed_role_unique', 'unique key does not lead with tenant_id'],
    ]);
  });

  it('rule 4: skips a constraint on the exemption list, and nothing else', async () => {
    const violations = await check(
      docs('title text') +
        lines(`FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id),
               CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n),
               CONSTRAINT lines_other_unique UNIQUE (doc_id, id)`),
      { ...STRICT, uniqueExemptions: ['app.lines.lines_doc_n_unique'] },
    );
    expect(violations.map((v) => v.constraint)).toEqual(['lines_other_unique']);
  });

  it('rule 4: a UNIQUE on id alone is exempt, like the primary key on id', async () => {
    const violations = await check(
      docs('title text') +
        lines(`FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id),
               CONSTRAINT lines_id_unique UNIQUE (id)`),
      STRICT,
    );
    expect(violations).toEqual([]);
  });

  it('rules 2, 3 and 4 are off by default: the same fixtures that fail with the option on pass without it', async () => {
    const noOrgFk = bare('FOREIGN KEY (tenant_id) REFERENCES app.tenants (id)');
    const plainFk =
      docs('title text') +
      lines('CONSTRAINT lines_doc_fk FOREIGN KEY (doc_id) REFERENCES app.docs (id)');
    const looseKey =
      docs('title text') +
      lines(`FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id),
             CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n)`);
    for (const fixture of [noOrgFk, plainFk, looseKey]) {
      expect(await check(fixture)).toEqual([]);
      expect(await check(fixture, { requireCompositeTenancy: false })).toEqual([]);
      expect(await check(fixture, STRICT)).not.toEqual([]);
    }
  });

  it('skips an allowlisted table for every tenant-integrity rule', async () => {
    const violations = await check(bare('title text'), {
      ...STRICT,
      allowlist: ['app.tenants', 'app.bare'],
    });
    expect(violations).toEqual([]);
  });

  it('names the table, the constraint and the rule in the message', async () => {
    const violations = await check(
      docs('title text') +
        lines('CONSTRAINT lines_doc_fk FOREIGN KEY (doc_id) REFERENCES app.docs (id)'),
      STRICT,
    );
    const message = describeViolations(violations);
    expect(message).toContain('app.lines');
    expect(message).toContain('lines_doc_fk');
    expect(message).toContain('foreign key not scoped by tenant_id');
    expect(message).toContain("paired with the parent's tenant_id");
  });
});
