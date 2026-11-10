// The Drizzle schema of 0034_procurement_orders (src/schema/procurement-orders.ts) must describe the SQL: the same
// tables and columns, and the same foreign keys (name, columns, parent table and parent columns), unique keys and
// indexes (name and columns) and checks (name only: CHECK bodies are not compared). tsc cannot see a drift between
// the two, and the API queries through Drizzle while the database enforces the SQL. No database needed: this
// reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/procurement-orders-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  PO_APPROVED_BANDS,
  PO_STATUSES,
  RECEIPT_KINDS,
  RECEIPT_STATUSES,
  purchaseOrderLines,
  purchaseOrderVersions,
  purchaseOrders,
  receiptLines,
  receiptSerials,
  receipts,
} from './schema/procurement-orders.js';

const SQL_TEXT =
  readFileSync(new URL('../migrations/0034_procurement_orders.sql', import.meta.url), 'utf8') +
  '\n' +
  readFileSync(
    new URL('../migrations/0038_discard_procurement_drafts.sql', import.meta.url),
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
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" DROP CONSTRAINT "(\w+)";/g)) {
    const shape = tables.get(m[1] ?? '');
    if (!shape) continue;
    for (const kind of ['foreignKey', 'unique', 'check', 'index'] as const) {
      shape.names[kind] = shape.names[kind].filter(
        (entry) => entry !== m[2] && !entry.startsWith(`${m[2]} (`),
      );
    }
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD CONSTRAINT "(\w+)" (.*);/g)) {
    if (!tables.has(m[1] ?? '')) continue;
    const kind = kindOf(m[3] ?? '');
    shapeOf(m[1] ?? '').names[kind].push(sqlEntry(kind, m[2] ?? '', m[3] ?? ''));
  }
  for (const m of text.matchAll(
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING btree \(([^)]*)\)/g,
  )) {
    if (tables.has(m[2] ?? ''))
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
  purchase_orders: purchaseOrders,
  purchase_order_versions: purchaseOrderVersions,
  purchase_order_lines: purchaseOrderLines,
  receipts,
  receipt_lines: receiptLines,
  receipt_serials: receiptSerials,
};

/** The values of `col IN ('a', 'b')` in the SQL text, for the CHECK named `check`. */
function checkValues(check: string): string[] {
  const m = [
    ...SQL_TEXT.matchAll(
      new RegExp(String.raw`CONSTRAINT "${check}" CHECK \("\w+" in \(([^)]*)\)\)`, 'g'),
    ),
  ].at(-1);
  if (!m) throw new Error(`no IN-list check ${check}`);
  return (m[1] ?? '').split(',').map((v) => v.trim().replaceAll("'", ''));
}

describe('0034_procurement_orders and src/schema/procurement-orders.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('create the same six tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'/g)].map((m) => m[1]);
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('keeps the exported catalogues equal to the SQL allow-lists', () => {
    expect(checkValues('purchase_orders_status_check')).toEqual([...PO_STATUSES]);
    expect(checkValues('purchase_orders_approved_band_check')).toEqual([...PO_APPROVED_BANDS]);
    expect(checkValues('receipts_status_check')).toEqual([...RECEIPT_STATUSES]);
    expect(checkValues('receipts_kind_check')).toEqual([...RECEIPT_KINDS]);
  });

  it('links the vendor through its account in the same entity', () => {
    const fks = parsed.get('purchase_orders')?.names.foreignKey ?? [];
    expect(fks).toContain(
      'purchase_orders_vendor_account_fk (tenant_id,organization_id,vendor_id) -> vendor_accounts(tenant_id,organization_id,vendor_id)',
    );
  });

  it('pins a receipt line to a line of its own purchase order, and a reversal to the same PO line', () => {
    const fks = parsed.get('receipt_lines')?.names.foreignKey ?? [];
    expect(fks).toContain(
      'receipt_lines_po_line_fk (tenant_id,organization_id,purchase_order_id,po_line_id) -> purchase_order_lines(tenant_id,organization_id,purchase_order_id,id)',
    );
    expect(fks).toContain(
      'receipt_lines_reverses_fk (tenant_id,organization_id,po_line_id,reverses_receipt_line_id) -> receipt_lines(tenant_id,organization_id,po_line_id,id)',
    );
  });

  it('keys a serial by its receipt line and number', () => {
    const uniques = parsed.get('receipt_serials')?.names.unique ?? [];
    expect(uniques).toContain(
      'receipt_serials_tenant_line_serial_unique (tenant_id,receipt_line_id,serial_no)',
    );
  });

  it('puts no foreign key on over_receipt_exception_id (no exceptions table yet)', () => {
    const fks = parsed.get('receipt_lines')?.names.foreignKey ?? [];
    expect(fks.filter((f) => /exception/.test(f))).toEqual([]);
  });
});
