// Tests for the rule sets of check-tenancy, against fixtures only (no migration runs). The real schema is checked
// in db.test.ts.
//  1. Tenant-scoped tables (ADR 0027 §6): a table on TENANT_SCOPED has tenant_id and must NOT have organization_id.
//  2. The counterparty-column rule (ADR 0027 §5): customer_party_id and vendor_party_id must be a nullable uuid,
//     with a foreign key to app.parties that checks the kind, and an index that leads with tenant_id. The old
//     customer_organization_id / vendor_organization_id columns are rejected.
//  3. The tenant-integrity rules (R17, ADR 0027 §8), read from pg_constraint. Rule 1 (tenant_id references
//     tenants) is always on. Rule 2 (organization_id references organizations), rule 3 (every other foreign key
//     to a tenant-owned table carries tenant_id), rule 4 (every UNIQUE / PRIMARY KEY other than one on id alone
//     leads with tenant_id) and rule 5 (a foreign key between two entity-owned tables carries organization_id)
//     are on by default; requireCompositeTenancy: false turns them off.
//
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Each case builds a tiny `app` schema inside a
// transaction and rolls it back, so nothing leaks between cases and no migration has to run.
// Run with: pnpm --filter @bos/db exec vitest run src/check-tenancy.test.ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ENTITY_FK_EXEMPTIONS,
  TENANT_SCOPED,
  checkTenancy,
  describeViolations,
} from './check-tenancy.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.adminUrl, max: 1 });
});

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
});

// The tables every fixture needs, shaped like ADR 0027 §2. app.tenants is allowlisted by default.
// app.organizations is the legal entity: organization_id = id is held by a CHECK, not a self foreign key, so it
// also shows that organizations is exempt from rule 2. app.parties is tenant-scoped (no organization_id) and
// has UNIQUE (tenant_id, id, kind) as the target for counterparty foreign keys that check the kind.
const BASE = `
  CREATE SCHEMA app;
  CREATE TABLE app.tenants (id uuid PRIMARY KEY);
  CREATE TABLE app.organizations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    organization_id uuid NOT NULL CHECK (organization_id = id),
    code text NOT NULL,
    UNIQUE (tenant_id, code),
    UNIQUE (tenant_id, id)
  );
  CREATE TABLE app.parties (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    kind text NOT NULL CHECK (kind IN ('customer', 'vendor')),
    code text NOT NULL,
    UNIQUE (tenant_id, code),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, id, kind)
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
 * A well-formed entity-owned document table: the two tenancy columns, the tenant and organization foreign keys,
 * UNIQUE (tenant_id, id) and UNIQUE (tenant_id, organization_id, id) as targets for composite foreign keys.
 * `body` adds columns and constraints.
 */
const docs = (body: string) => `
  CREATE TABLE app.docs (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    ${body},
    FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, organization_id, id)
  );`;

/**
 * The ADR 0027 §5 counterparty shape: the party column, a stored generated kind column fixed to `kind`, and the
 * foreign key (tenant_id, <kind>_party_id, <kind>_party_kind) -> app.parties (tenant_id, id, kind).
 */
const party = (kind: 'customer' | 'vendor') => `
  ${kind}_party_id uuid,
  ${kind}_party_kind text GENERATED ALWAYS AS ('${kind}') STORED,
  CONSTRAINT docs_${kind}_party_fk FOREIGN KEY (tenant_id, ${kind}_party_id, ${kind}_party_kind)
    REFERENCES app.parties (tenant_id, id, kind)`;

/** The index a portal read on `<kind>_party_id` uses. */
const partyIndex = (kind: 'customer' | 'vendor') =>
  `CREATE INDEX docs_${kind}_idx ON app.docs (tenant_id, ${kind}_party_id);`;

/** A table with the two tenancy columns and NO constraints beyond `body`: the starting point for rules 1 and 2. */
const bare = (body: string) => `
  CREATE TABLE app.bare (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    ${body}
  );`;

/** An entity-owned child of app.docs with its own tenant and organization foreign keys; `body` adds the rest. */
const lines = (body: string) => `
  CREATE TABLE app.lines (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    doc_id uuid NOT NULL, party_id uuid, n int NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
    FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),
    ${body}
  );`;

/** The well-formed foreign key from app.lines to app.docs: tenant, entity and id, each paired with the parent's. */
const LINES_DOC_FK =
  'FOREIGN KEY (tenant_id, organization_id, doc_id) REFERENCES app.docs (tenant_id, organization_id, id)';

/** A well-formed tenant-scoped table (ADR 0027 §7: FX rates are a market fact, shared by every entity). */
const fxRates = (extra = '') => `
  CREATE TABLE app.fx_rates (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id),
    currency text NOT NULL, rate_date date NOT NULL, ${extra}
    UNIQUE (tenant_id, currency, rate_date)
  );`;

describe('tenant-scoped tables (ADR 0027 §6)', () => {
  it('lists the tenant-level tables including the verification review journal', () => {
    expect([...TENANT_SCOPED].sort()).toEqual(
      [
        'app.customers',
        'app.customer_contacts',
        'app.customer_contact_phones',
        'app.verification_cases',
        'app.verification_review_events',
        'app.tax_codes',
        'app.payment_terms',
        'app.lead_lost_reasons',
        'app.withholding_codes',
        'app.vendors',
        'app.vendor_contacts',
        'app.vendor_contact_phones',
        'app.vendor_bank_accounts',
        'app.access_revisions',
        'app.authz_versions',
        'app.fx_rates',
        'app.idp_orgs',
        'app.parties',
        'app.role_permissions',
        'app.role_permission_levels',
        'app.tenants',
        'app.user_roles',
        'app.users',
      ].sort(),
    );
  });

  it('accepts a tenant-scoped table without organization_id', async () => {
    // app.parties in BASE is one already; fx_rates is a second, with a tenant-leading business key.
    expect(await check(fxRates())).toEqual([]);
  });

  it('fails when a tenant-scoped table has organization_id, with one violation only', async () => {
    const violations = await check(
      fxRates(`organization_id uuid NOT NULL,
               FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),`),
    );
    expect(violations).toEqual([
      {
        table: 'app.fx_rates',
        column: 'organization_id',
        problem: 'present on a tenant-scoped table',
      },
    ]);
    expect(describeViolations(violations)).toContain('must not have organization_id');
  });

  it('still requires tenant_id and its foreign key on a tenant-scoped table', async () => {
    const violations = await check(
      'CREATE TABLE app.fx_rates (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, currency text);',
    );
    expect(violations).toEqual([
      { table: 'app.fx_rates', column: 'tenant_id', problem: 'no foreign key to app.tenants' },
    ]);
  });

  it('takes the list from the tenantScoped option', async () => {
    // Without app.fx_rates on the list, it is an entity table and its missing organization_id is reported.
    const violations = await check(fxRates(), { tenantScoped: ['app.tenants', 'app.parties'] });
    expect(violations).toEqual([
      { table: 'app.fx_rates', column: 'organization_id', problem: 'missing' },
    ]);
  });
});

describe('counterparty columns: a well-formed fixture passes', () => {
  it('accepts a nullable uuid FK to app.parties with the kind and a (tenant_id, column) index', async () => {
    expect(await check(docs(party('customer')) + partyIndex('customer'))).toEqual([]);
  });

  it('accepts the vendor column, and a table with both columns', async () => {
    const violations = await check(
      docs(`${party('customer')}, ${party('vendor')}`) +
        partyIndex('customer') +
        partyIndex('vendor'),
    );
    expect(violations).toEqual([]);
  });

  it('accepts a plain kind column held by a CHECK (the ADR fallback)', async () => {
    const violations = await check(
      docs(`customer_party_id uuid,
            customer_party_kind text NOT NULL DEFAULT 'customer' CHECK (customer_party_kind = 'customer'),
            FOREIGN KEY (tenant_id, customer_party_id, customer_party_kind)
              REFERENCES app.parties (tenant_id, id, kind)`) + partyIndex('customer'),
    );
    expect(violations).toEqual([]);
  });

  it('accepts a longer tenant-leading index that contains the column', async () => {
    const violations = await check(
      docs(party('customer')) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, organization_id, customer_party_id);',
    );
    expect(violations).toEqual([]);
  });

  it('does not apply to tables without a counterparty column', async () => {
    expect(await check(docs('title text'))).toEqual([]);
  });
});

describe('counterparty columns: a malformed fixture fails', () => {
  const GOOD_INDEX = partyIndex('customer');
  const KIND = "customer_party_kind text GENERATED ALWAYS AS ('customer') STORED";
  const KIND_FK = `FOREIGN KEY (tenant_id, customer_party_id, customer_party_kind)
                     REFERENCES app.parties (tenant_id, id, kind)`;

  it('fails when the column is NOT NULL', async () => {
    const violations = await check(
      docs(`customer_party_id uuid NOT NULL, ${KIND}, ${KIND_FK}`) + GOOD_INDEX,
    );
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_party_id', problem: 'not nullable' },
    ]);
  });

  it('fails when the column is not a uuid', async () => {
    const violations = await check(docs('customer_party_id text') + GOOD_INDEX);
    const problems = violations.map((v) => v.problem);
    expect(problems).toContain('not uuid');
    // A text column cannot reference a uuid key, so the missing FK is reported too.
    expect(problems).toContain('no foreign key to app.parties');
  });

  it('fails when there is no foreign key', async () => {
    const violations = await check(docs('customer_party_id uuid') + GOOD_INDEX);
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_party_id', problem: 'no foreign key to app.parties' },
    ]);
  });

  it('fails when the foreign key does not target app.parties', async () => {
    // Tenant-scoped, so rule 3 is satisfied; it is the target that is wrong.
    const violations = await check(
      docs(`customer_party_id uuid,
            FOREIGN KEY (tenant_id, customer_party_id) REFERENCES app.organizations (tenant_id, id)`) +
        GOOD_INDEX,
    );
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_party_id', problem: 'no foreign key to app.parties' },
    ]);
  });

  it('fails when the foreign key to app.parties does not check the kind', async () => {
    const violations = await check(
      docs(`customer_party_id uuid,
            CONSTRAINT docs_customer_party_fk FOREIGN KEY (tenant_id, customer_party_id)
              REFERENCES app.parties (tenant_id, id)`) + GOOD_INDEX,
    );
    expect(violations).toEqual([
      {
        table: 'app.docs',
        column: 'customer_party_id',
        constraint: 'docs_customer_party_fk',
        problem: 'foreign key to app.parties does not check the kind',
      },
    ]);
    const message = describeViolations(violations);
    expect(message).toContain('app.docs constraint docs_customer_party_fk');
    expect(message).toContain('app.parties (tenant_id, id, kind)');
  });

  it('rejects the old customer_organization_id column, even when it is well-formed for ADR 0017', async () => {
    const violations = await check(
      docs(`customer_organization_id uuid,
            FOREIGN KEY (tenant_id, customer_organization_id) REFERENCES app.organizations (tenant_id, id)`) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, customer_organization_id);',
    );
    expect(violations).toEqual([
      {
        table: 'app.docs',
        column: 'customer_organization_id',
        problem: 'counterparty is an organization column',
      },
    ]);
    expect(describeViolations(violations)).toContain('customer_party_id');
  });

  it('fails when there is no index at all', async () => {
    const violations = await check(docs(party('customer')));
    expect(violations).toEqual([
      { table: 'app.docs', column: 'customer_party_id', problem: 'no tenant-leading index' },
    ]);
  });

  it('fails when the only index is on tenant_id alone', async () => {
    // It leads with tenant_id, but it does not contain the column, so the portal filter cannot use it.
    const violations = await check(
      docs(party('customer')) + 'CREATE INDEX docs_tenant_idx ON app.docs (tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index does not lead with tenant_id', async () => {
    const violations = await check(
      docs(party('customer')) + 'CREATE INDEX docs_idx ON app.docs (customer_party_id, tenant_id);',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('fails when the index is partial', async () => {
    const violations = await check(
      docs(party('customer')) +
        'CREATE INDEX docs_idx ON app.docs (tenant_id, customer_party_id) WHERE organization_id IS NOT NULL;',
    );
    expect(violations.map((v) => v.problem)).toEqual(['no tenant-leading index']);
  });

  it('reports the vendor column by its own name', async () => {
    const violations = await check(docs(`${party('customer')}, vendor_party_id uuid`) + GOOD_INDEX);
    expect(violations.map((v) => [v.column, v.problem])).toEqual([
      ['vendor_party_id', 'no foreign key to app.parties'],
      ['vendor_party_id', 'no tenant-leading index'],
    ]);
  });

  it('skips an allowlisted table', async () => {
    const violations = await check(docs('customer_party_id uuid'), {
      allowlist: ['app.tenants', 'app.docs'],
    });
    expect(violations).toEqual([]);
  });

  it('names the table, the column and the rule in the message', async () => {
    const violations = await check(docs('customer_party_id uuid NOT NULL'));
    const message = describeViolations(violations);
    expect(message).toContain('app.docs.customer_party_id: not nullable');
    expect(message).toContain('nullable uuid with a foreign key to app.parties');
  });
});

// Tenant integrity (R17, ADR 0027 §8). The rules read pg_constraint, so a fixture names its constraint explicitly
// wherever the test is about one, and never relies on what Postgres would call it.
describe('tenant integrity: a well-formed fixture passes', () => {
  it('accepts a schema shaped like ADR 0027, in strict mode (the default) and with it off', async () => {
    const fixture =
      // ops.regions has no tenant_id, so a plain foreign key to it is not subject to rule 3.
      `CREATE SCHEMA ops; CREATE TABLE ops.regions (id uuid PRIMARY KEY);
       CREATE TABLE app.idp_orgs (
         id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id),
         zitadel_org_id text NOT NULL, kind text NOT NULL, party_id uuid, name text NOT NULL,
         CONSTRAINT idp_orgs_zitadel_org_id_unique UNIQUE (zitadel_org_id),
         UNIQUE (tenant_id, id),
         UNIQUE (tenant_id, party_id),
         CHECK ((kind = 'staff') = (party_id IS NULL)),
         FOREIGN KEY (tenant_id, party_id, kind) REFERENCES app.parties (tenant_id, id, kind)
       );
       CREATE TABLE app.users (
         id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id),
         zitadel_user_id text NOT NULL, idp_org_id uuid NOT NULL,
         CONSTRAINT users_zitadel_user_id_unique UNIQUE (zitadel_user_id),
         UNIQUE (tenant_id, id),
         FOREIGN KEY (tenant_id, idp_org_id) REFERENCES app.idp_orgs (tenant_id, id)
       );
       CREATE TABLE app.user_roles (
         tenant_id uuid NOT NULL REFERENCES app.tenants (id), user_id uuid NOT NULL, role_key text NOT NULL,
         PRIMARY KEY (tenant_id, user_id, role_key),
         FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id)
       );
       CREATE TABLE app.user_entities (
         id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL, user_id uuid NOT NULL,
         FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
         FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id),
         FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id),
         UNIQUE (tenant_id, organization_id, user_id)
       );` +
      fxRates() +
      docs(`title text, ${party('customer')}`) +
      partyIndex('customer') +
      lines(`region_id uuid REFERENCES ops.regions (id),
             ${LINES_DOC_FK},
             FOREIGN KEY (tenant_id, party_id) REFERENCES app.parties (tenant_id, id),
             UNIQUE (tenant_id, doc_id, n)`);
    expect(await check(fixture)).toEqual([]);
    expect(await check(fixture, { requireCompositeTenancy: false })).toEqual([]);
  });

  it('accepts a single-column organization_id foreign key (rule 2 allows either shape)', async () => {
    const violations = await check(
      bare(`FOREIGN KEY (tenant_id) REFERENCES app.tenants (id),
            FOREIGN KEY (organization_id) REFERENCES app.organizations (id)`),
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
    const violations = await check(bare('FOREIGN KEY (tenant_id) REFERENCES app.tenants (id)'));
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
        lines(`${LINES_DOC_FK},
               CONSTRAINT lines_party_fk FOREIGN KEY (party_id) REFERENCES app.parties (id)`),
    );
    expect(violations).toEqual([
      {
        table: 'app.lines',
        column: 'party_id',
        constraint: 'lines_party_fk',
        problem: 'foreign key not scoped by tenant_id',
      },
    ]);
  });

  it('rule 3: fails when tenant_id is in the foreign key but paired with the wrong parent column', async () => {
    // Postgres accepts this: the parent's UNIQUE (tenant_id, id) covers the column set {id, tenant_id}, in any order.
    const violations = await check(
      docs('title text') +
        lines(`${LINES_DOC_FK},
               CONSTRAINT lines_party_fk FOREIGN KEY (tenant_id, party_id) REFERENCES app.parties (id, tenant_id)`),
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['lines_party_fk', 'foreign key not scoped by tenant_id'],
    ]);
  });

  it('rule 4: fails when a UNIQUE constraint does not lead with tenant_id', async () => {
    const violations = await check(
      docs('title text') +
        lines(`${LINES_DOC_FK},
               CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n)`),
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
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['keyed_pk', 'unique key does not lead with tenant_id'],
      ['keyed_role_unique', 'unique key does not lead with tenant_id'],
    ]);
  });

  it('rule 4: the global IdP ids are exempt by constraint name, and only those keys', async () => {
    const violations = await check(
      `CREATE TABLE app.idp_orgs (
         id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id),
         zitadel_org_id text NOT NULL, name text NOT NULL,
         CONSTRAINT idp_orgs_zitadel_org_id_unique UNIQUE (zitadel_org_id),
         CONSTRAINT idp_orgs_name_unique UNIQUE (name)
       );`,
    );
    expect(violations.map((v) => v.constraint)).toEqual(['idp_orgs_name_unique']);
  });

  it('rule 4: skips a constraint on the exemption list, and nothing else', async () => {
    const violations = await check(
      docs('title text') +
        lines(`${LINES_DOC_FK},
               CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n),
               CONSTRAINT lines_other_unique UNIQUE (doc_id, id)`),
      { uniqueExemptions: ['app.lines.lines_doc_n_unique'] },
    );
    expect(violations.map((v) => v.constraint)).toEqual(['lines_other_unique']);
  });

  it('rule 4: a UNIQUE on id alone is exempt, like the primary key on id', async () => {
    const violations = await check(
      docs('title text') +
        lines(`${LINES_DOC_FK},
               CONSTRAINT lines_id_unique UNIQUE (id)`),
    );
    expect(violations).toEqual([]);
  });

  it('rule 5: fails when a 2-column foreign key between entity-owned tables leaves out organization_id', async () => {
    const violations = await check(
      docs('title text') +
        lines(
          'CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id)',
        ),
    );
    expect(violations).toEqual([
      {
        table: 'app.lines',
        column: 'tenant_id, doc_id',
        constraint: 'lines_doc_fk',
        problem: 'foreign key between entity-owned tables not scoped by organization_id',
      },
    ]);
  });

  it("rule 5: fails when organization_id is in the foreign key but not paired with the parent's", async () => {
    // Postgres accepts this: UNIQUE (tenant_id, organization_id, id) covers the column set in any order.
    const violations = await check(
      docs('title text') +
        lines(`CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, organization_id, doc_id)
                 REFERENCES app.docs (tenant_id, id, organization_id)`),
    );
    expect(violations.map((v) => [v.constraint, v.problem])).toEqual([
      ['lines_doc_fk', 'foreign key between entity-owned tables not scoped by organization_id'],
    ]);
  });

  it('rule 5: skips a constraint on the exemption list, which is empty by default', async () => {
    expect(ENTITY_FK_EXEMPTIONS).toEqual([]);
    const violations = await check(
      docs('title text') +
        lines(
          'CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id)',
        ),
      { entityFkExemptions: ['app.lines.lines_doc_fk'] },
    );
    expect(violations).toEqual([]);
  });

  it('strict mode is the default: rules 2 to 5 fail with no options and are off only with false', async () => {
    const noOrgFk = bare('FOREIGN KEY (tenant_id) REFERENCES app.tenants (id)');
    const plainFk =
      docs('title text') +
      lines(`${LINES_DOC_FK},
             CONSTRAINT lines_party_fk FOREIGN KEY (party_id) REFERENCES app.parties (id)`);
    const looseKey =
      docs('title text') +
      lines(`${LINES_DOC_FK},
             CONSTRAINT lines_doc_n_unique UNIQUE (doc_id, n)`);
    const noEntityFk =
      docs('title text') +
      lines(
        'CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id)',
      );
    for (const fixture of [noOrgFk, plainFk, looseKey, noEntityFk]) {
      const byDefault = await check(fixture);
      expect(byDefault).toHaveLength(1);
      expect(await check(fixture, {})).toEqual(byDefault);
      expect(await check(fixture, { requireCompositeTenancy: true })).toEqual(byDefault);
      expect(await check(fixture, { requireCompositeTenancy: false })).toEqual([]);
    }
  });

  it('skips an allowlisted table for every tenant-integrity rule', async () => {
    const violations = await check(bare('title text'), { allowlist: ['app.tenants', 'app.bare'] });
    expect(violations).toEqual([]);
  });

  it('names the table, the constraint and the rule in the message', async () => {
    const violations = await check(
      docs('title text') +
        lines(
          'CONSTRAINT lines_doc_fk FOREIGN KEY (tenant_id, doc_id) REFERENCES app.docs (tenant_id, id)',
        ),
    );
    const message = describeViolations(violations);
    expect(message).toContain('app.lines constraint lines_doc_fk (tenant_id, doc_id)');
    expect(message).toContain('not scoped by organization_id');
    expect(message).toContain("paired with the parent's organization_id");
  });
});
