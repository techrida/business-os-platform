// The Drizzle schema of 0020_sales_orders (src/schema/sales.ts) must describe the SQL: the same tables and columns,
// the same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and columns)
// and checks (name only), and the same allow-lists as the exported catalogues. It also pins the one-live-SO index,
// the deferred schedule-sum triggers and the audit attach. The FK billing_schedule_lines_invoice_fk lives in 0021
// (SQL only, like 0016's FKs onto S1 tables) and is asserted by sales.test.ts on Postgres.
// No database needed: this reads 0020 and the billing-percent changes in 0042.
// Run with: pnpm --filter @bos/db exec vitest run src/sales-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import {
  BILLING_SCHEDULE_STATUSES,
  BILLING_TRIGGERS,
  SALES_ORDER_EVIDENCE_KINDS,
  SALES_ORDER_LIVE_STATUSES,
  SALES_ORDER_STATUSES,
  billingScheduleLines,
  salesOrderEvidence,
  salesOrderLines,
  salesOrderTaxSummary,
  salesOrders,
} from './schema/sales.js';

const SQL_TEXT = readFileSync(
  new URL('../migrations/0020_sales_orders.sql', import.meta.url),
  'utf8',
);

const PRECISION_SQL = readFileSync(
  new URL('../migrations/0042_billing_schedule_percent_precision.sql', import.meta.url),
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
      const constraint = /^\s*CONSTRAINT "(\w+)" (.*?),?$/.exec(line);
      if (constraint) {
        const kind = kindOf(constraint[2] ?? '');
        shape.names[kind].push(sqlEntry(kind, constraint[1] ?? '', constraint[2] ?? ''));
        continue;
      }
      const column = /^\s*"(\w+)" /.exec(line);
      if (column) shape.columns.push(column[1] ?? '');
    }
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)"\s+DROP CONSTRAINT "(\w+)"/g)) {
    const shape = shapeOf(m[1] ?? '');
    shape.names.check = shape.names.check.filter((name) => name !== m[2]);
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)"\s+RENAME COLUMN "(\w+)" TO "(\w+)"/g)) {
    const shape = shapeOf(m[1] ?? '');
    shape.columns = shape.columns.map((column) => (column === m[2] ? m[3]! : column));
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)"\s+ADD CONSTRAINT "(\w+)" (.*);/g)) {
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
  sales_orders: salesOrders,
  sales_order_lines: salesOrderLines,
  sales_order_tax_summary: salesOrderTaxSummary,
  sales_order_evidence: salesOrderEvidence,
  billing_schedule_lines: billingScheduleLines,
};

/** The quoted values of `"<column>" in ('a', 'b')` inside the named CHECK constraint. */
function checkList(constraint: string, column: string): string[] {
  const line = new RegExp(`CONSTRAINT "${constraint}" CHECK \\((.*)\\),?$`, 'm').exec(SQL_TEXT);
  if (!line) throw new Error(`no CHECK ${constraint} in 0020`);
  const list = new RegExp(`"${column}" in \\(([^)]*)\\)`).exec(line[1] ?? '');
  if (!list) throw new Error(`no "${column}" in (...) in ${constraint}`);
  return [...(list[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1] ?? '');
}

describe('sales migrations and src/schema/sales.ts', () => {
  const parsed = parseSql(`${SQL_TEXT}\n${PRECISION_SQL}`);

  it('create the same five tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('keeps the SQL allow-lists equal to the exported catalogues', () => {
    expect(checkList('sales_orders_status_check', 'status')).toEqual([...SALES_ORDER_STATUSES]);
    expect(checkList('billing_schedule_lines_status_check', 'status')).toEqual([
      ...BILLING_SCHEDULE_STATUSES,
    ]);
    expect(checkList('billing_schedule_lines_trigger_check', 'trigger')).toEqual([
      ...BILLING_TRIGGERS,
    ]);
    expect(checkList('sales_order_evidence_kind_check', 'evidence_kind')).toEqual([
      ...SALES_ORDER_EVIDENCE_KINDS,
    ]);
  });

  it('allows one live sales order per quotation (live = every status but cancelled)', () => {
    expect(SQL_TEXT).toContain(
      `CREATE UNIQUE INDEX "sales_orders_one_live_per_quotation" ON "app"."sales_orders" USING btree ("tenant_id", "organization_id", "quotation_id") WHERE "status" <> 'cancelled';`,
    );
    expect(SALES_ORDER_LIVE_STATUSES).toEqual(
      SALES_ORDER_STATUSES.filter((s) => s !== 'cancelled'),
    );
  });

  it('checks the schedule sum at commit, from the lines and from the order', () => {
    expect(SQL_TEXT).toMatch(
      /CREATE CONSTRAINT TRIGGER "billing_schedule_lines_sum" AFTER INSERT OR UPDATE OR DELETE ON "app"\."billing_schedule_lines"\nDEFERRABLE INITIALLY DEFERRED\n/,
    );
    expect(SQL_TEXT).toMatch(
      /CREATE CONSTRAINT TRIGGER "sales_orders_schedule_sum" AFTER UPDATE OF "total", "status" ON "app"\."sales_orders"\nDEFERRABLE INITIALLY DEFERRED\n/,
    );
  });

  it('has no stored paid amount (A8: paid is derived)', () => {
    for (const table of Object.values(DRIZZLE)) {
      const names = getTableConfig(table).columns.map((c) => c.name);
      expect(names.filter((n) => n.includes('paid'))).toEqual([]);
    }
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('exports the sales tables from the package', () => {
    expect(api.salesOrders).toBe(salesOrders);
    expect(api.salesOrderLines).toBe(salesOrderLines);
    expect(api.salesOrderTaxSummary).toBe(salesOrderTaxSummary);
    expect(api.salesOrderEvidence).toBe(salesOrderEvidence);
    expect(api.billingScheduleLines).toBe(billingScheduleLines);
  });
});
