// The Drizzle schema of 0015_crm (src/schema/crm.ts) must describe the SQL: the same tables and columns, and the
// same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only: CHECK bodies are not compared). tsc cannot see a drift between the two, and the API
// queries through Drizzle while the database enforces the SQL. No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/crm-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import {
  activities,
  customerContactPhones,
  customerContacts,
  customers,
  leadLostReasons,
  leadPhones,
  leads,
  opportunities,
  partyAccounts,
  proposals,
  requirements,
  verificationCases,
} from './schema/crm.js';

const SQL_TEXT = readFileSync(new URL('../migrations/0015_crm.sql', import.meta.url), 'utf8');
/** 0031 alters verification_cases (party_kind column, party FK instead of the customer FK); read on top of 0015. */
const ALTER_TEXT = readFileSync(
  new URL('../migrations/0031_verification_party_kind.sql', import.meta.url),
  'utf8',
);

type Kind = 'foreignKey' | 'unique' | 'check' | 'index';

interface Shape {
  columns: string[];
  names: Record<Kind, string[]>;
}

const empty = (): Shape => ({
  columns: [],
  names: { foreignKey: [], unique: [], check: [], index: [] },
});

/** `"a", "b"` -> `a,b`. */
const cols = (list: string) => list.replaceAll('"', '').replaceAll(' ', '');

/** An index column list without operator classes: `"a" gin_trgm_ops, "b"` -> `a,b`. */
const indexCols = (list: string) =>
  list
    .split(',')
    .map((c) => (c.trim().split(/\s+/)[0] ?? '').replaceAll('"', ''))
    .join(',');

/** One comparable line per constraint: the name, plus its columns (and parent, for a foreign key). */
function sqlEntry(kind: Kind, name: string, definition: string): string {
  if (kind === 'foreignKey') {
    const m = /^FOREIGN KEY \(([^)]*)\) REFERENCES "app"\."(\w+)"\(([^)]*)\)/.exec(definition);
    if (!m) throw new Error(`unparsed foreign key ${name}: ${definition}`);
    return `${name} (${cols(m[1] ?? '')}) -> ${m[2] ?? ''}(${cols(m[3] ?? '')})`;
  }
  if (kind === 'unique') {
    const m = /^UNIQUE\(([^)]*)\)/.exec(definition);
    if (!m) throw new Error(`unparsed unique key ${name}: ${definition}`);
    return `${name} (${cols(m[1] ?? '')})`;
  }
  return name;
}

function kindOf(definition: string): Kind {
  if (definition.startsWith('FOREIGN KEY')) return 'foreignKey';
  if (definition.startsWith('UNIQUE')) return 'unique';
  if (definition.startsWith('CHECK')) return 'check';
  throw new Error(`unknown constraint: ${definition}`);
}

/** Tables, columns and named constraints/indexes, read from the migration text. */
function parseSql(text: string): Map<string, Shape> {
  const tables = new Map<string, Shape>();
  const shapeOf = (table: string) => {
    const shape = tables.get(table) ?? empty();
    tables.set(table, shape);
    return shape;
  };
  for (const block of text.matchAll(/CREATE TABLE "app"\."(\w+)" \(\n([\s\S]*?)\n\);/g)) {
    const shape = shapeOf(block[1] ?? '');
    for (const line of (block[2] ?? '').split('\n')) {
      const constraint = /^\s*CONSTRAINT "(\w+)" (.*)$/.exec(line);
      if (constraint) {
        const kind = kindOf(constraint[2] ?? '');
        shape.names[kind].push(sqlEntry(kind, constraint[1] ?? '', constraint[2] ?? ''));
        continue;
      }
      const column = /^\s*"(\w+)" /.exec(line);
      if (column) shape.columns.push(column[1] ?? '');
    }
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD CONSTRAINT "(\w+)" (.*);/g)) {
    const kind = kindOf(m[3] ?? '');
    shapeOf(m[1] ?? '').names[kind].push(sqlEntry(kind, m[2] ?? '', m[3] ?? ''));
  }
  for (const m of text.matchAll(
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING (?:btree|gin) \(([^)]*)\)/g,
  )) {
    shapeOf(m[2] ?? '').names.index.push(`${m[1] ?? ''} (${indexCols(m[3] ?? '')})`);
  }
  return tables;
}

/** Removes the constraint or index `name` (with or without its column list) from `shape`. */
function dropName(shape: Shape, name: string): void {
  for (const kind of Object.keys(shape.names) as Kind[]) {
    shape.names[kind] = shape.names[kind].filter((e) => e !== name && !e.startsWith(`${name} (`));
  }
}

/**
 * Applies the ADD COLUMN, DROP CONSTRAINT, DROP COLUMN, DROP INDEX and ADD CONSTRAINT lines of a later migration
 * to the parsed tables. `foreign` names tables of another schema file that the migration also alters (0191 and
 * 0194 touch vendors too); their drops are skipped, and a drop on any other unknown table throws.
 */
function applyAlters(tables: Map<string, Shape>, text: string, foreign: string[] = []): void {
  const target = (table: string) => {
    const shape = tables.get(table);
    if (!shape && !foreign.includes(table)) throw new Error(`drop on unknown table ${table}`);
    return shape;
  };
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD COLUMN "(\w+)" /g)) {
    tables.get(m[1] ?? '')?.columns.push(m[2] ?? '');
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" DROP CONSTRAINT "(\w+)";/g)) {
    const shape = target(m[1] ?? '');
    if (shape) dropName(shape, m[2] ?? '');
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" DROP COLUMN "(\w+)";/g)) {
    const shape = target(m[1] ?? '');
    if (shape) shape.columns = shape.columns.filter((c) => c !== m[2]);
  }
  // DROP INDEX names no table: drop the name wherever it was parsed (IF EXISTS: it may be on an unread table).
  for (const m of text.matchAll(/DROP INDEX (?:IF EXISTS )?"app"\."(\w+)";/g)) {
    for (const shape of tables.values()) dropName(shape, m[1] ?? '');
  }
  for (const [table, shape] of parseSql(text)) {
    const target = tables.get(table);
    if (!target) continue;
    for (const kind of Object.keys(shape.names) as Kind[])
      target.names[kind].push(...shape.names[kind]);
  }
}

function drizzleShape(table: PgTable): Shape {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map((c) => c.name),
    names: {
      foreignKey: config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        const parent = getTableConfig(ref.foreignTable).name;
        const own = ref.columns.map((c) => c.name).join(',');
        const theirs = ref.foreignColumns.map((c) => c.name).join(',');
        return `${fk.getName()} (${own}) -> ${parent}(${theirs})`;
      }),
      unique: config.uniqueConstraints.map(
        (u) => `${u.getName() ?? '(unnamed)'} (${u.columns.map((c) => c.name).join(',')})`,
      ),
      check: config.checks.map((c) => c.name),
      index: config.indexes.map(
        (i) =>
          `${i.config.name ?? '(unnamed)'} (${i.config.columns
            .map((c) => ('name' in c ? c.name : '(sql)'))
            .join(',')})`,
      ),
    },
  };
}

const sorted = (shape: Shape): Shape => ({
  columns: [...shape.columns].sort(),
  names: {
    foreignKey: [...shape.names.foreignKey].sort(),
    unique: [...shape.names.unique].sort(),
    check: [...shape.names.check].sort(),
    index: [...shape.names.index].sort(),
  },
});

const DRIZZLE: Record<string, PgTable> = {
  customers,
  customer_contacts: customerContacts,
  verification_cases: verificationCases,
  party_accounts: partyAccounts,
  leads,
  opportunities,
  requirements,
  proposals,
  activities,
};

describe('0015_crm and src/schema/crm.ts', () => {
  const parsed = parseSql(SQL_TEXT);
  applyAlters(parsed, ALTER_TEXT);
  const reviewSql = readFileSync(
    new URL('../migrations/0040_verification_document_review.sql', import.meta.url),
    'utf8',
  );
  for (const column of reviewSql.matchAll(/ALTER TABLE app\.(\w+) ADD COLUMN (\w+) /g)) {
    const shape = parsed.get(column[1]!);
    if (!shape) throw new Error('Review migration alters an unknown CRM table');
    shape.columns.push(column[2]!);
  }
  // 0062 adds activities.cancelled_at, created_by_user_id (with its FK) and the planned-per-lead index.
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0062_activity_follow_ups.sql', import.meta.url), 'utf8'),
  );
  // 0054 adds customers.logo_document_id (no FK, no index).
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0054_party_logos.sql', import.meta.url), 'utf8'),
  );
  // 0071 adds leads.lost_reason_id (with its FK) and creates lead_lost_reasons, checked on its own below.
  const lostReasonsSql = readFileSync(
    new URL('../migrations/0071_lead_lost_reasons.sql', import.meta.url),
    'utf8',
  );
  applyAlters(parsed, lostReasonsSql);
  // 0080 adds leads.department_id and created_by_user_id and opportunities.department_id, with their keys and indexes.
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0080_lead_department_stamp.sql', import.meta.url), 'utf8'),
  );
  // 0090 adds opportunities.lost_reason_id (with its FK to lead_lost_reasons).
  applyAlters(
    parsed,
    readFileSync(
      new URL('../migrations/0090_opportunity_lost_reason.sql', import.meta.url),
      'utf8',
    ),
  );
  // 0100 adds leads.held_from_stage and opportunities.held_from_stage (with their checks).
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0100_crm_held_from_stage.sql', import.meta.url), 'utf8'),
  );
  // 0101 adds opportunities.lead_creator_user_id (with its FK to users and its index).
  applyAlters(
    parsed,
    readFileSync(
      new URL('../migrations/0101_opportunity_lead_creator.sql', import.meta.url),
      'utf8',
    ),
  );
  // 0103 adds the credit override columns of opportunities (with their FK to users and their check).
  applyAlters(
    parsed,
    readFileSync(
      new URL('../migrations/0103_opportunity_credit_override.sql', import.meta.url),
      'utf8',
    ),
  );
  // 0170 adds the order value the override was given for (with its check).
  applyAlters(
    parsed,
    readFileSync(
      new URL('../migrations/0170_credit_override_order_value.sql', import.meta.url),
      'utf8',
    ),
  );
  // 0183 adds the quotation version the override was given for (with its check). Its composite FK to
  // quotation_versions lives in SQL only (like 0016's won-version FK), so crm.ts need not import quotations.ts:
  // it is pinned here and then set aside before the comparison with Drizzle.
  const overrideVersionFk =
    'opportunities_credit_override_quotation_version_fk (tenant_id,organization_id,credit_override_quotation_version_id) -> quotation_versions(tenant_id,organization_id,id)';
  applyAlters(
    parsed,
    readFileSync(
      new URL('../migrations/0183_credit_override_quotation_version.sql', import.meta.url),
      'utf8',
    ),
  );
  // FX9: 0191 adds customers.country, address_line and address_city (dropping the address jsonb and its check),
  // and leads.country and customer_contacts.country; 0192 adds leads.phones_search with its gin trigram index and
  // creates the phone tables (checked on their own below); 0194 drops the phone_e164 columns, checks and indexes.
  // 0191 and 0194 also alter the vendor tables, which vendors-schema.test.ts checks.
  const phonesSql = readFileSync(
    new URL('../migrations/0192_party_phones.sql', import.meta.url),
    'utf8',
  );
  const vendorTables = ['vendors', 'vendor_contacts'];
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0191_party_country_address.sql', import.meta.url), 'utf8'),
    vendorTables,
  );
  applyAlters(parsed, phonesSql, vendorTables);
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0194_drop_owner_phone_e164.sql', import.meta.url), 'utf8'),
    vendorTables,
  );
  // D9: 0199 adds leads.address_line and address_city with leads_address_check.
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0199_lead_address.sql', import.meta.url), 'utf8'),
    vendorTables,
  );
  const opportunityShape = parsed.get('opportunities');
  const sqlOnlyFks = opportunityShape?.names.foreignKey.filter((e) => e === overrideVersionFk);
  if (opportunityShape) {
    opportunityShape.names.foreignKey = opportunityShape.names.foreignKey.filter(
      (e) => e !== overrideVersionFk,
    );
  }

  it('0183 ties the override to one quotation version with a composite FK, kept in SQL only', () => {
    expect(sqlOnlyFks).toEqual([overrideVersionFk]);
    expect(opportunityShape?.columns).toContain('credit_override_quotation_version_id');
    expect(opportunityShape?.names.check).toContain(
      'opportunities_credit_override_quotation_version_check',
    );
  });

  it('create the same nine tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('0071 lead_lost_reasons: same columns, keys, checks and indexes', () => {
    const created = parseSql(lostReasonsSql).get('lead_lost_reasons');
    expect(getTableConfig(leadLostReasons).schema).toBe('app');
    expect(sorted(drizzleShape(leadLostReasons))).toEqual(sorted(created ?? empty()));
    expect(lostReasonsSql).toContain("SELECT audit.attach('app.lead_lost_reasons');");
  });

  const PHONE_TABLES: Record<string, PgTable> = {
    customer_contact_phones: customerContactPhones,
    lead_phones: leadPhones,
  };

  it.each(Object.keys(PHONE_TABLES))('0192 %s: same columns, keys, checks and indexes', (name) => {
    const table = PHONE_TABLES[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parseSql(phonesSql).get(name) ?? empty()));
    expect(phonesSql).toContain(`SELECT audit.attach('app.${name}');`);
  });

  it('0191 and 0194 drop customers.address and the phone_e164 columns of customer_contacts and leads', () => {
    expect(parsed.get('customer_contacts')?.columns).not.toContain('phone_e164');
    expect(parsed.get('leads')?.columns).not.toContain('phone_e164');
    expect(parsed.get('customers')?.columns).not.toContain('address');
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('gives proposals no price column (A2 C11)', () => {
    const columns = getTableConfig(proposals).columns.map((c) => c.name);
    expect(columns.filter((c) => /price|amount|total|value|cost/.test(c))).toEqual([]);
  });

  it('exports the CRM tables from the package', () => {
    expect(api.customers).toBe(customers);
    expect(api.activities).toBe(activities);
    expect(api.verificationCases).toBe(verificationCases);
  });
});
