// The Drizzle schema of 0176_party_import_batches and its 0185 expiry change (src/schema/party-imports.ts) must describe the SQL: the same
// columns, foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only), and the status allow-list must equal the exported catalogue. No database needed.
// Run with: pnpm --filter @bos/db exec vitest run src/party-imports-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  PARTY_IMPORT_BATCH_KINDS,
  PARTY_IMPORT_BATCH_STATUSES,
  partyImportBatches,
} from './schema/party-imports.js';

const SQL_TEXT = readFileSync(
  new URL('../migrations/0176_party_import_batches.sql', import.meta.url),
  'utf8',
);
/** 0185 (round 5, FU11) adds the `expired` status: it re-creates two checks and adds one index. */
const EXPIRY_SQL = readFileSync(
  new URL('../migrations/0185_party_import_batches_expiry.sql', import.meta.url),
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

/** Constraints that live in SQL only: none in 0176. */
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

const DRIZZLE: Record<string, PgTable> = { party_import_batches: partyImportBatches };

describe('0176_party_import_batches + 0185 and src/schema/party-imports.ts', () => {
  const parsed = parseSql(SQL_TEXT);
  // Apply 0185 on top of 0176: a dropped constraint leaves, then what it adds is read like any other statement.
  const expiry = parseSql(EXPIRY_SQL).get('party_import_batches') ?? empty();
  const base = parsed.get('party_import_batches');
  if (base !== undefined) {
    const dropped = [...EXPIRY_SQL.matchAll(/DROP CONSTRAINT "(\w+)"/g)].map((m) => m[1]);
    base.names.check = base.names.check.filter((n) => !dropped.includes(n));
    for (const kind of Object.keys(expiry.names) as Kind[])
      base.names[kind].push(...expiry.names[kind]);
  }

  it('creates one table', () => {
    expect([...parsed.keys()]).toEqual(['party_import_batches']);
  });

  it('describes the same columns, keys, checks and indexes', () => {
    expect(getTableConfig(partyImportBatches).schema).toBe('app');
    expect(sorted(drizzleShape(partyImportBatches))).toEqual(
      sorted(parsed.get('party_import_batches') ?? empty()),
    );
  });

  it('keeps the kind and status allow-lists equal to the exported catalogues', () => {
    const listIn = (text: string, name: string) => {
      const line = new RegExp(`CONSTRAINT "${name}" CHECK \\((.*)\\)[,;]?$`, 'm').exec(text);
      return [...(line?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    };
    expect(listIn(SQL_TEXT, 'party_import_batches_kind_check')).toEqual([
      ...PARTY_IMPORT_BATCH_KINDS,
    ]);
    expect(listIn(EXPIRY_SQL, 'party_import_batches_status_check')).toEqual([
      ...PARTY_IMPORT_BATCH_STATUSES,
    ]);
  });

  it('is audited with its uploaded rows redacted, and guarded against change after the commit', () => {
    expect(SQL_TEXT).toContain("SELECT audit.attach('app.party_import_batches', ARRAY['rows']);");
    expect(Object.keys(DRIZZLE)).toEqual(['party_import_batches']);
    expect(SQL_TEXT).toContain(
      'CREATE TRIGGER "party_import_batches_guard" BEFORE UPDATE OR DELETE',
    );
  });
});
