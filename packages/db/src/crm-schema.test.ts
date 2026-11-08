// The Drizzle schema of 0015_crm (src/schema/crm.ts) must describe the SQL exactly: the same tables, columns,
// foreign keys, unique keys, checks and indexes, by name. tsc cannot see a drift between the two, and the API
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
  leads,
  opportunities,
  partyAccounts,
  proposals,
  requirements,
  verificationCases,
} from './schema/crm.js';

const SQL_TEXT = readFileSync(new URL('../migrations/0015_crm.sql', import.meta.url), 'utf8');

type Kind = 'foreignKey' | 'unique' | 'check' | 'index';

interface Shape {
  columns: string[];
  names: Record<Kind, string[]>;
}

const empty = (): Shape => ({
  columns: [],
  names: { foreignKey: [], unique: [], check: [], index: [] },
});

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
        shape.names[kindOf(constraint[2] ?? '')].push(constraint[1] ?? '');
        continue;
      }
      const column = /^\s*"(\w+)" /.exec(line);
      if (column) shape.columns.push(column[1] ?? '');
    }
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD CONSTRAINT "(\w+)" (.*);/g)) {
    shapeOf(m[1] ?? '').names[kindOf(m[3] ?? '')].push(m[2] ?? '');
  }
  for (const m of text.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)"/g)) {
    shapeOf(m[2] ?? '').names.index.push(m[1] ?? '');
  }
  return tables;
}

function drizzleShape(table: PgTable): Shape {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map((c) => c.name),
    names: {
      foreignKey: config.foreignKeys.map((fk) => fk.getName()),
      unique: config.uniqueConstraints.map((u) => u.getName() ?? '(unnamed)'),
      check: config.checks.map((c) => c.name),
      index: config.indexes.map((i) => i.config.name ?? '(unnamed)'),
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

  it('create the same nine tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
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
