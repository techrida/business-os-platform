// The Drizzle schema of 0032_vendors (src/schema/vendors.ts) must describe the SQL: the same tables and columns, and the
// same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only: CHECK bodies are not compared). tsc cannot see a drift between the two, and the API
// queries through Drizzle while the database enforces the SQL. No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/vendors-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  vendorAccounts,
  vendorBankAccounts,
  vendorContactPhones,
  vendorContacts,
  vendors,
} from './schema/vendors.js';

const SQL_TEXT = readFileSync(new URL('../migrations/0032_vendors.sql', import.meta.url), 'utf8');

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

/** Removes the constraint or index `name` (with or without its column list) from `shape`. */
function dropName(shape: Shape, name: string): void {
  for (const kind of Object.keys(shape.names) as Kind[]) {
    shape.names[kind] = shape.names[kind].filter((e) => e !== name && !e.startsWith(`${name} (`));
  }
}

/**
 * Applies the ADD COLUMN, DROP CONSTRAINT, DROP COLUMN, DROP INDEX and ADD CONSTRAINT lines of a later migration
 * to the parsed tables. `foreign` names tables of another schema file that the migration also alters (0191 and
 * 0194 touch the CRM tables too); their drops are skipped, and a drop on any other unknown table throws.
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
    const into = tables.get(table);
    if (!into) continue;
    for (const kind of Object.keys(shape.names) as Kind[])
      into.names[kind].push(...shape.names[kind]);
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
  vendors,
  vendor_contacts: vendorContacts,
  vendor_accounts: vendorAccounts,
  vendor_bank_accounts: vendorBankAccounts,
};

describe('0032_vendors and src/schema/vendors.ts', () => {
  const parsed = parseSql(SQL_TEXT);
  // 0054 adds vendors.logo_document_id (no FK, no index).
  const logosSql = readFileSync(
    new URL('../migrations/0054_party_logos.sql', import.meta.url),
    'utf8',
  );
  for (const m of logosSql.matchAll(/ALTER TABLE "app"\."(\w+)" ADD COLUMN "(\w+)" /g)) {
    parsed.get(m[1]!)?.columns.push(m[2]!);
  }
  // FX9: 0191 adds vendors.address_line and address_city (with vendors_address_check) and vendor_contacts.country;
  // 0192 creates vendor_contact_phones (checked on its own below); 0194 drops vendor_contacts.phone_e164 and its
  // check. 0191 and 0194 also alter the CRM tables, which crm-schema.test.ts checks.
  const crmTables = ['customers', 'customer_contacts', 'leads'];
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0191_party_country_address.sql', import.meta.url), 'utf8'),
    crmTables,
  );
  const phonesSql = readFileSync(
    new URL('../migrations/0192_party_phones.sql', import.meta.url),
    'utf8',
  );
  applyAlters(parsed, phonesSql, crmTables);
  applyAlters(
    parsed,
    readFileSync(new URL('../migrations/0194_drop_owner_phone_e164.sql', import.meta.url), 'utf8'),
    crmTables,
  );

  it('create the same four tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('0192 vendor_contact_phones: same columns, keys, checks and indexes', () => {
    expect(getTableConfig(vendorContactPhones).schema).toBe('app');
    expect(sorted(drizzleShape(vendorContactPhones))).toEqual(
      sorted(parseSql(phonesSql).get('vendor_contact_phones') ?? empty()),
    );
    expect(phonesSql).toContain("SELECT audit.attach('app.vendor_contact_phones');");
  });

  it('0194 leaves no phone_e164 column on vendor_contacts', () => {
    expect(parsed.get('vendor_contacts')?.columns).not.toContain('phone_e164');
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'/g)].map((m) => m[1]);
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('redacts the encrypted account number from the audit trail', () => {
    expect(SQL_TEXT).toContain(
      "audit.attach('app.vendor_bank_accounts', ARRAY['account_number_enc'])",
    );
  });

  it('adds no foreign key on vendor_accounts.default_withholding_code_id (S-AP adds it)', () => {
    const fks = parsed.get('vendor_accounts')?.names.foreignKey ?? [];
    expect(fks.filter((f) => f.includes('default_withholding_code_id'))).toEqual([]);
  });
});
