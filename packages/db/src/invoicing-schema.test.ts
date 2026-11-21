// The Drizzle schema of 0021_invoices and 0023_invoice_credit_release (src/schema/invoicing.ts) must describe the
// SQL: the same tables and columns, the same foreign keys (name, columns, parent table and parent columns), unique
// keys and indexes (name and columns) and checks (name only), and the same allow-lists as the exported catalogues. It
// also pins the guards the database enforces with triggers and indexes: G3 (issued is immutable, but for the one
// credit-release marker), G4 (one live tax invoice per schedule line, until its invoice is credited in full), the
// credit-note cap, the append-only print log and the schedule line's invoice FK (SQL only; see sales.ts).
// No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/invoicing-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import {
  INVOICE_EDITABLE_STATUSES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  invoiceLines,
  invoicePrintLog,
  invoiceTaxSummary,
  invoices,
} from './schema/invoicing.js';

const SQL_TEXT = readFileSync(new URL('../migrations/0021_invoices.sql', import.meta.url), 'utf8');
const SQL_0023 = readFileSync(
  new URL('../migrations/0023_invoice_credit_release.sql', import.meta.url),
  'utf8',
);
const SQL_0051 = readFileSync(
  new URL('../migrations/0051_render_format_snapshot.sql', import.meta.url),
  'utf8',
);
const SQL_0024 = readFileSync(
  new URL('../migrations/0024_credit_note_line_link.sql', import.meta.url),
  'utf8',
);

const SQL_0177 = readFileSync(
  new URL('../migrations/0177_invoices_issue_date_index.sql', import.meta.url),
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
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD COLUMN "(\w+)" /g)) {
    shapeOf(m[1] ?? '').columns.push(m[2] ?? '');
  }
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD CONSTRAINT "(\w+)" (.*);/g)) {
    const kind = kindOf(m[3] ?? '');
    shapeOf(m[1] ?? '').names[kind].push(sqlEntry(kind, m[2] ?? '', m[3] ?? ''));
  }
  for (const m of text.matchAll(
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING btree \(([^)]*)\)/g,
  )) {
    // 0023 recreates an index of 0021 under the same name and columns (only its predicate changes).
    const entry = `${m[1] ?? ''} (${cols(m[3] ?? '')})`;
    const indexes = shapeOf(m[2] ?? '').names.index;
    if (!indexes.includes(entry)) indexes.push(entry);
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
  invoices,
  invoice_lines: invoiceLines,
  invoice_tax_summary: invoiceTaxSummary,
  invoice_print_log: invoicePrintLog,
};

/** The quoted values of `"<column>" in ('a', 'b')` inside the named CHECK constraint. */
function checkList(constraint: string, column: string): string[] {
  const line = new RegExp(`CONSTRAINT "${constraint}" CHECK \\((.*)\\),?$`, 'm').exec(SQL_TEXT);
  if (!line) throw new Error(`no CHECK ${constraint} in 0021`);
  const list = new RegExp(`"${column}" in \\(([^)]*)\\)`).exec(line[1] ?? '');
  if (!list) throw new Error(`no "${column}" in (...) in ${constraint}`);
  return [...(list[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1] ?? '');
}

describe('0021_invoices and src/schema/invoicing.ts', () => {
  const parsed = parseSql(`${SQL_TEXT}\n${SQL_0023}\n${SQL_0024}\n${SQL_0051}\n${SQL_0177}`);

  it('create the same four tables', () => {
    const created = [...SQL_TEXT.matchAll(/CREATE TABLE "app"\."(\w+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('adds the schedule line half of the invoice cycle, through the order', () => {
    expect(parsed.get('billing_schedule_lines')?.names.foreignKey).toEqual([
      'billing_schedule_lines_invoice_fk (tenant_id,organization_id,sales_order_id,invoice_id) -> invoices(tenant_id,organization_id,sales_order_id,id)',
    ]);
  });

  it('keeps the SQL allow-lists equal to the exported catalogues', () => {
    expect(checkList('invoices_kind_check', 'kind')).toEqual([...INVOICE_KINDS]);
    expect(checkList('invoices_status_check', 'status')).toEqual([...INVOICE_STATUSES]);
  });

  it('G4: allows one live (not discarded) tax invoice per schedule line', () => {
    expect(SQL_TEXT).toContain(
      `CREATE UNIQUE INDEX "invoices_one_live_tax_invoice_per_schedule_line" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "schedule_line_id") WHERE "kind" = 'tax_invoice' AND "status" <> 'discarded' AND "schedule_line_id" IS NOT NULL;`,
    );
  });

  it('0023 adds the credit-release marker and recreates the G4 index and the guard', () => {
    expect(SQL_0023).toContain(
      `ALTER TABLE "app"."invoices" ADD COLUMN "credited_in_full_at" timestamp with time zone;`,
    );
    expect(SQL_0023).toContain(
      `CREATE UNIQUE INDEX "invoices_one_live_tax_invoice_per_schedule_line" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "schedule_line_id") WHERE "kind" = 'tax_invoice' AND "status" <> 'discarded' AND "schedule_line_id" IS NOT NULL AND "credited_in_full_at" IS NULL;`,
    );
    expect(SQL_0023).toContain(`CREATE OR REPLACE FUNCTION "app"."invoices_guard"()`);
    // The trigger of 0021 stays attached (CREATE OR REPLACE) and 0023 adds no table, so it needs no audit.attach.
    expect(SQL_0023).not.toMatch(/CREATE TRIGGER|CREATE TABLE|audit\.attach/);
  });

  it('G3: guards invoices, and their lines and tax summary while not editable', () => {
    expect(SQL_TEXT).toContain(
      `CREATE TRIGGER "invoices_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."invoices"`,
    );
    expect(SQL_TEXT).toContain(
      `v_ignored CONSTANT text[] := ARRAY['version', 'updated_at', 'customer_party_kind'];`,
    );
    for (const child of ['invoice_lines', 'invoice_tax_summary']) {
      expect(SQL_TEXT).toContain(
        `CREATE TRIGGER "${child}_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."${child}"`,
      );
    }
    const editable = INVOICE_EDITABLE_STATUSES.map((s) => `'${s}'`).join(', ');
    expect(SQL_TEXT).toContain(`IF v_status NOT IN (${editable}) THEN`);
  });

  it('checks credit and debit notes at commit, not per statement', () => {
    expect(SQL_TEXT).toMatch(
      /CREATE CONSTRAINT TRIGGER "invoices_notes" AFTER INSERT OR UPDATE ON "app"\."invoices"\nDEFERRABLE INITIALLY DEFERRED\n/,
    );
  });

  it('keeps the print log append-only (raise trigger, no UPDATE or DELETE for bos_app)', () => {
    expect(SQL_TEXT).toContain(
      `CREATE TRIGGER "invoice_print_log_append_only" BEFORE UPDATE OR DELETE ON "app"."invoice_print_log"`,
    );
    expect(SQL_TEXT).toContain(
      `REVOKE UPDATE, DELETE ON "app"."invoice_print_log" FROM "bos_app";`,
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

  it('exports the invoicing tables from the package', () => {
    expect(api.invoices).toBe(invoices);
    expect(api.invoiceLines).toBe(invoiceLines);
    expect(api.invoiceTaxSummary).toBe(invoiceTaxSummary);
    expect(api.invoicePrintLog).toBe(invoicePrintLog);
  });
});
