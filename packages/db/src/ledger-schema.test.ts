// The Drizzle schema of 0019_open_items (src/schema/ledger.ts) must describe the SQL: the same tables and columns,
// the same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only), the same view columns, and the same allow-lists as the exported catalogues that
// LedgerService types its writes with. No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/ledger-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, getViewConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import {
  OPEN_ITEM_SOURCE_TYPES,
  POSTING_EVENT_SOURCE_TYPES,
  POSTING_EVENTS,
  RECEIVABLE_SOURCE_TYPES,
  WITHHOLDING_APPLIES_TO,
  openItemAllocations,
  openItemBalances,
  openItems,
  postingEvents,
  withholdingCodes,
} from './schema/ledger.js';

const SQL_TEXT = readFileSync(
  new URL('../migrations/0019_open_items.sql', import.meta.url),
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

/** Constraints that live in SQL only (Drizzle 0.45 cannot express EXCLUDE). */
const SQL_ONLY = ['withholding_codes_no_overlap'];

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
  withholding_codes: withholdingCodes,
  open_items: openItems,
  open_item_allocations: openItemAllocations,
  posting_events: postingEvents,
};

const APPEND_ONLY = ['open_items', 'open_item_allocations', 'posting_events'];

/** The quoted values of `"<column>" in ('a', 'b')` inside the named CHECK constraint. */
function checkList(constraint: string, column: string): string[] {
  const line = new RegExp(`CONSTRAINT "${constraint}" CHECK \\((.*)\\),?$`, 'm').exec(SQL_TEXT);
  if (!line) throw new Error(`no CHECK ${constraint} in 0019`);
  const list = new RegExp(`"${column}" in \\(([^)]*)\\)`).exec(line[1] ?? '');
  if (!list) throw new Error(`no "${column}" in (...) in ${constraint}`);
  return [...(list[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1] ?? '');
}

/** The output column names of CREATE VIEW open_item_balances: the alias, or the column itself. */
function viewColumns(): string[] {
  const view = /CREATE VIEW "app"\."open_item_balances"[^\n]*\nSELECT\n([\s\S]*?)\nFROM /;
  const m = view.exec(SQL_TEXT);
  if (!m) throw new Error('no open_item_balances view in 0019');
  return (m[1] ?? '').split('\n').map((line) => {
    const names = [...line.matchAll(/"(\w+)"/g)].map((n) => n[1] ?? '');
    return names.at(-1) ?? '';
  });
}

describe('0019_open_items and src/schema/ledger.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('create the same four tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('declares the view open_item_balances with the columns the SQL selects', () => {
    const config = getViewConfig(openItemBalances);
    expect(config.schema).toBe('app');
    expect(config.name).toBe('open_item_balances');
    const drizzleColumns = Object.values(config.selectedFields).map(
      (c) => (c as { name: string }).name,
    );
    expect(drizzleColumns.sort()).toEqual(viewColumns().sort());
  });

  it('keeps the SQL allow-lists equal to the exported catalogues', () => {
    expect(checkList('open_items_source_type_check', 'source_type')).toEqual([
      ...OPEN_ITEM_SOURCE_TYPES,
    ]);
    expect(checkList('open_items_source_side_check', 'source_type')).toEqual([
      ...RECEIVABLE_SOURCE_TYPES,
    ]);
    expect(checkList('posting_events_source_type_check', 'source_type')).toEqual([
      ...POSTING_EVENT_SOURCE_TYPES,
    ]);
    expect(checkList('posting_events_event_check', 'event')).toEqual([...POSTING_EVENTS]);
    expect(checkList('withholding_codes_applies_to_check', 'applies_to')).toEqual([
      ...WITHHOLDING_APPLIES_TO,
    ]);
  });

  it('already allows the three P4 payable sources and events', () => {
    expect(OPEN_ITEM_SOURCE_TYPES).toEqual(
      expect.arrayContaining(['vendor_bill', 'vendor_payment', 'vendor_debit_note']),
    );
    expect(POSTING_EVENTS).toEqual(
      expect.arrayContaining([
        'vendor_bill_posted',
        'vendor_payment_made',
        'vendor_debit_note_issued',
      ]),
    );
  });

  it('forbids overlapping withholding-code periods per (tenant_id, code) with an EXCLUDE constraint', () => {
    expect(SQL_TEXT).toContain(
      `ALTER TABLE "app"."withholding_codes" ADD CONSTRAINT "withholding_codes_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "code" WITH =, daterange("effective_from", "effective_to", '[)') WITH &&);`,
    );
  });

  it.each(APPEND_ONLY)(
    '%s: append-only (raise trigger, no UPDATE or DELETE for bos_app)',
    (name) => {
      expect(SQL_TEXT).toContain(
        `CREATE TRIGGER "${name}_append_only" BEFORE UPDATE OR DELETE ON "app"."${name}"`,
      );
      expect(SQL_TEXT).toContain(`REVOKE UPDATE, DELETE ON "app"."${name}" FROM "bos_app";`);
      const columns = getTableConfig(DRIZZLE[name] as PgTable).columns.map((c) => c.name);
      expect(columns.filter((c) => c === 'updated_at' || c === 'version')).toEqual([]);
    },
  );

  it('checks the allocation cap at commit, not per statement', () => {
    expect(SQL_TEXT).toMatch(
      /CREATE CONSTRAINT TRIGGER "open_item_allocations_cap" AFTER INSERT ON "app"\."open_item_allocations"\nDEFERRABLE INITIALLY DEFERRED\n/,
    );
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('exports the ledger tables from the package', () => {
    expect(api.openItems).toBe(openItems);
    expect(api.openItemAllocations).toBe(openItemAllocations);
    expect(api.postingEvents).toBe(postingEvents);
    expect(api.openItemBalances).toBe(openItemBalances);
    expect(api.withholdingCodes).toBe(withholdingCodes);
  });
});
