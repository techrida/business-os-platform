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
  customerContacts,
  customers,
  leadLostReasons,
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
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING btree \(([^)]*)\)/g,
  )) {
    shapeOf(m[2] ?? '').names.index.push(`${m[1] ?? ''} (${cols(m[3] ?? '')})`);
  }
  return tables;
}

/** Applies the ADD COLUMN, DROP CONSTRAINT and ADD CONSTRAINT lines of a later migration to the parsed tables. */
function applyAlters(tables: Map<string, Shape>, text: string): void {
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD COLUMN "(\w+)" /g)) {
    tables.get(m[1] ?? '')?.columns.push(m[2] ?? '');
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" DROP CONSTRAINT "(\w+)";/g)) {
    const shape = tables.get(m[1] ?? '');
    if (!shape) throw new Error(`drop on unknown table ${m[1] ?? ''}`);
    for (const kind of Object.keys(shape.names) as Kind[]) {
      shape.names[kind] = shape.names[kind].filter((e) => e !== m[2] && !e.startsWith(`${m[2]} (`));
    }
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
