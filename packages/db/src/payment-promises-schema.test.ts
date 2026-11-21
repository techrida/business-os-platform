// The Drizzle schema of 0113_payment_promises (src/schema/payment-promises.ts) must describe the SQL: the same
// columns, foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only), and the status allow-list must equal the exported catalogue. No database needed.
// Run with: pnpm --filter @bos/db exec vitest run src/payment-promises-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { PAYMENT_PROMISE_STATUSES, paymentPromises } from './schema/payment-promises.js';

const SQL_TEXT = readFileSync(
  new URL('../migrations/0113_payment_promises.sql', import.meta.url),
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

/** Constraints that live in SQL only: none in 0113. */
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

const DRIZZLE: Record<string, PgTable> = { payment_promises: paymentPromises };

describe('0113_payment_promises and src/schema/payment-promises.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('creates one table', () => {
    expect([...parsed.keys()]).toEqual(['payment_promises']);
  });

  it('describes the same columns, keys, checks and indexes', () => {
    expect(getTableConfig(paymentPromises).schema).toBe('app');
    expect(sorted(drizzleShape(paymentPromises))).toEqual(
      sorted(parsed.get('payment_promises') ?? empty()),
    );
  });

  it('keeps the status allow-list equal to the exported catalogue', () => {
    // 0153 redefines the check (adds `replaced`): the last definition across the migrations is the live one.
    const replaced = readFileSync(
      new URL('../migrations/0153_payment_promise_replaced.sql', import.meta.url),
      'utf8',
    );
    const lines = [
      ...`${SQL_TEXT}\n${replaced}`.matchAll(
        /CONSTRAINT "payment_promises_status_check" CHECK \((.*)\)[,;]?$/gm,
      ),
    ];
    expect(lines).toHaveLength(2);
    const list = [...(lines.at(-1)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(list).toEqual([...PAYMENT_PROMISE_STATUSES]);
  });

  it('allows one open promise per invoice', () => {
    expect(SQL_TEXT).toContain(
      'CREATE UNIQUE INDEX "payment_promises_one_open_idx" ON "app"."payment_promises" USING btree ("tenant_id", "organization_id", "invoice_id") WHERE "status" = \'open\';',
    );
  });

  it('is audited', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached).toEqual(Object.keys(DRIZZLE));
  });
});
