// The Drizzle schema of 0022_payments (src/schema/payments.ts) must describe the SQL: the same tables and columns,
// the same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only), and the same allow-lists as the exported catalogues. No database needed: this reads the
// migration file. (The package export of the tables is U1's index.ts line, so it is not asserted here.)
// Run with: pnpm --filter @bos/db exec vitest run src/payments-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_CHANNELS,
  PAYMENT_CURRENCIES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  paymentProofs,
  payments,
} from './schema/payments.js';

const SQL_TEXT = readFileSync(new URL('../migrations/0022_payments.sql', import.meta.url), 'utf8');

type Kind = 'foreignKey' | 'unique' | 'check' | 'index';

interface Shape {
  columns: string[];
  names: Record<Kind, string[]>;
}

const empty = (): Shape => ({
  columns: [],
  names: { foreignKey: [], unique: [], check: [], index: [] },
});

/** Constraints that live in SQL only: none in 0022. */
const SQL_ONLY: string[] = [];

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
    if (SQL_ONLY.includes(m[2] ?? '')) continue;
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
  payments,
  payment_proofs: paymentProofs,
};

/** The quoted values of `"<column>" in ('a', 'b')` inside the named CHECK constraint. */
function checkList(constraint: string, column: string): string[] {
  const line = new RegExp(`CONSTRAINT "${constraint}" CHECK \\((.*)\\),?$`, 'm').exec(SQL_TEXT);
  if (!line) throw new Error(`no CHECK ${constraint} in 0022`);
  const list = new RegExp(`"${column}" in \\(([^)]*)\\)`).exec(line[1] ?? '');
  if (!list) throw new Error(`no "${column}" in (...) in ${constraint}`);
  return [...(list[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1] ?? '');
}

describe('0022_payments and src/schema/payments.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('create the same two tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('keeps the SQL allow-lists equal to the exported catalogues', () => {
    expect(checkList('payments_status_check', 'status')).toEqual([...PAYMENT_STATUSES]);
    expect(checkList('payments_method_check', 'method')).toEqual([...PAYMENT_METHODS]);
    expect(checkList('payments_channel_check', 'channel')).toEqual([...PAYMENT_CHANNELS]);
    expect(checkList('payments_currency_check', 'currency')).toEqual([...PAYMENT_CURRENCIES]);
  });

  it('has no paid or allocated column: paid is derived from allocations (A8)', () => {
    const columns = getTableConfig(payments).columns.map((c) => c.name);
    expect(columns.filter((c) => /paid|allocated/.test(c))).toEqual([]);
  });

  it('keeps payments mutable (version, updated_at, lifecycle trigger) and refuses DELETE to bos_app', () => {
    expect(getTableConfig(payments).columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['version', 'updated_at']),
    );
    expect(SQL_TEXT).toContain('CREATE TRIGGER "payments_guard" BEFORE UPDATE ON "app"."payments"');
    expect(SQL_TEXT).toContain('REVOKE DELETE ON "app"."payments" FROM "bos_app";');
  });

  it('makes payment_proofs append-only (raise trigger, no UPDATE or DELETE for bos_app)', () => {
    expect(SQL_TEXT).toContain(
      'CREATE TRIGGER "payment_proofs_append_only" BEFORE UPDATE OR DELETE ON "app"."payment_proofs"',
    );
    expect(SQL_TEXT).toContain('REVOKE UPDATE, DELETE ON "app"."payment_proofs" FROM "bos_app";');
    const columns = getTableConfig(paymentProofs).columns.map((c) => c.name);
    expect(columns.filter((c) => c === 'updated_at' || c === 'version')).toEqual([]);
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });
});
