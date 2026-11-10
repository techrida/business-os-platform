// The Drizzle schema of 0035_payables (src/schema/payables.ts) must describe the SQL: the same tables and columns,
// and the same foreign keys (name, columns, parent table and parent columns), unique keys and indexes (name and
// columns) and checks (name only: CHECK bodies are not compared); the view v_po_line_progress must expose the same
// columns. tsc cannot see a drift between the two, and the API queries through Drizzle while the database enforces
// the SQL. No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/payables-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, getViewConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  BILL_KINDS,
  BILL_STATUSES,
  BILL_SUBMISSION_STATUSES,
  MATCH_EXCEPTION_STATUSES,
  MATCH_RESULT_STATUSES,
  MATCH_STATUSES,
  PAYMENT_REQUEST_STATUSES,
  PAYMENT_TYPES,
  matchExceptions,
  matchResults,
  paymentRequestLines,
  paymentRequests,
  poLineProgress,
  vendorBillLines,
  vendorBillSubmissions,
  vendorBills,
} from './schema/payables.js';

const BASE_SQL = readFileSync(new URL('../migrations/0035_payables.sql', import.meta.url), 'utf8');
const SQL_TEXT =
  BASE_SQL +
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

/** Tables created by the migration (columns and named constraints/indexes), read from the migration text. */
function parseCreated(text: string): Map<string, Shape> {
  const tables = new Map<string, Shape>();
  for (const block of text.matchAll(/CREATE TABLE "app"\."(\w+)" \(\n([\s\S]*?)\n\);/g)) {
    const shape = empty();
    tables.set(block[1] ?? '', shape);
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
    const shape = tables.get(m[1] ?? '');
    if (shape)
      shape.names[kindOf(m[3] ?? '')].push(sqlEntry(kindOf(m[3] ?? ''), m[2] ?? '', m[3] ?? ''));
  }
  for (const m of text.matchAll(
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING btree \(([^)]*)\)/g,
  )) {
    const shape = tables.get(m[2] ?? '');
    if (shape) shape.names.index.push(`${m[1] ?? ''} (${cols(m[3] ?? '')})`);
  }
  return tables;
}

/** Constraints this migration adds to tables of earlier migrations (ALTER TABLE ... ADD CONSTRAINT). */
function parseAltered(text: string): Map<string, string[]> {
  const altered = new Map<string, string[]>();
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD CONSTRAINT "(\w+)" (.*);/g)) {
    const kind = kindOf(m[3] ?? '');
    const list = altered.get(m[1] ?? '') ?? [];
    list.push(sqlEntry(kind, m[2] ?? '', m[3] ?? ''));
    altered.set(m[1] ?? '', list);
  }
  return altered;
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
  vendor_bills: vendorBills,
  vendor_bill_submissions: vendorBillSubmissions,
  vendor_bill_lines: vendorBillLines,
  match_results: matchResults,
  match_exceptions: matchExceptions,
  payment_requests: paymentRequests,
  payment_request_lines: paymentRequestLines,
};

/** The values of `col in ('a', 'b')` in the SQL text, for the CHECK named `check`. */
function checkValues(check: string): string[] {
  const m = [
    ...SQL_TEXT.matchAll(
      new RegExp(String.raw`CONSTRAINT "${check}" CHECK \("\w+" in \(([^)]*)\)\)`, 'g'),
    ),
  ].at(-1);
  if (!m) throw new Error(`no IN-list check ${check}`);
  return (m[1] ?? '').split(',').map((v) => v.trim().replaceAll("'", ''));
}

/** The output column names of CREATE VIEW v_po_line_progress: the alias, or the column itself. */
function viewColumns(): string[] {
  const view = /CREATE VIEW "app"\."v_po_line_progress"[^\n]*\nSELECT\n([\s\S]*?)\nFROM /;
  const m = view.exec(SQL_TEXT);
  if (!m) throw new Error('no v_po_line_progress view in 0035');
  return (m[1] ?? '').split('\n').map((line) => {
    const names = [...line.matchAll(/"(\w+)"/g)].map((n) => n[1] ?? '');
    return names.at(-1) ?? '';
  });
}

describe('0035_payables and src/schema/payables.ts', () => {
  const created = parseCreated(SQL_TEXT);
  const altered = parseAltered(BASE_SQL);

  it('create the same seven tables', () => {
    expect([...created.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(created.get(name) ?? empty()));
  });

  it('declares the view v_po_line_progress with the columns the SQL selects', () => {
    const config = getViewConfig(poLineProgress);
    expect(config.schema).toBe('app');
    expect(config.name).toBe('v_po_line_progress');
    const drizzleColumns = Object.values(config.selectedFields).map(
      (c) => (c as { name: string }).name,
    );
    expect(drizzleColumns.sort()).toEqual(viewColumns().sort());
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'/g)].map((m) => m[1]);
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('does not create withholding_codes (P3 owns it) and only adds the vendor_accounts FK to it', () => {
    expect(SQL_TEXT).not.toMatch(/CREATE TABLE "app"\."withholding_codes"/);
    expect([...altered.keys()]).toEqual(['vendor_accounts']);
    expect(altered.get('vendor_accounts')).toEqual([
      'vendor_accounts_default_withholding_code_fk (tenant_id,default_withholding_code_id) -> withholding_codes(tenant_id,id)',
    ]);
  });

  it('keeps the exported catalogues equal to the SQL allow-lists', () => {
    expect(checkValues('vendor_bills_status_check')).toEqual([...BILL_STATUSES]);
    expect(checkValues('vendor_bills_kind_check')).toEqual([...BILL_KINDS]);
    expect(checkValues('vendor_bills_match_status_check')).toEqual([...MATCH_STATUSES]);
    expect(checkValues('vendor_bill_submissions_status_check')).toEqual([
      ...BILL_SUBMISSION_STATUSES,
    ]);
    expect(checkValues('match_results_status_check')).toEqual([...MATCH_RESULT_STATUSES]);
    expect(checkValues('match_exceptions_status_check')).toEqual([...MATCH_EXCEPTION_STATUSES]);
    expect(checkValues('payment_requests_status_check')).toEqual([...PAYMENT_REQUEST_STATUSES]);
    expect(checkValues('payment_requests_payment_type_check')).toEqual([...PAYMENT_TYPES]);
  });

  it('dedups a bill on the normalised invoice number per vendor, entity and fiscal year', () => {
    expect(created.get('vendor_bills')?.names.index).toContain(
      'vendor_bills_tenant_org_vendor_invoice_fy_unique (tenant_id,organization_id,vendor_id,invoice_no_norm,fiscal_year)',
    );
    expect(SQL_TEXT).toMatch(
      /CREATE UNIQUE INDEX "vendor_bills_tenant_org_vendor_invoice_fy_unique"[^\n]+WHERE "status" <> 'discarded'/,
    );
    expect(SQL_TEXT).toMatch(
      /"invoice_no_norm" text GENERATED ALWAYS AS \(upper\(regexp_replace\("vendor_invoice_no", '\[\[:space:\]\/-\]', '', 'g'\)\)\) STORED/,
    );
  });

  it('pins a bill line to a PO line and a receipt line of the same entity and PO', () => {
    const fks = created.get('vendor_bill_lines')?.names.foreignKey ?? [];
    expect(fks).toContain(
      'vendor_bill_lines_bill_fk (tenant_id,organization_id,vendor_bill_id) -> vendor_bills(tenant_id,organization_id,id)',
    );
    expect(fks).toContain(
      'vendor_bill_lines_po_line_fk (tenant_id,organization_id,purchase_order_id,po_line_id) -> purchase_order_lines(tenant_id,organization_id,purchase_order_id,id)',
    );
    expect(fks).toContain(
      'vendor_bill_lines_receipt_line_fk (tenant_id,organization_id,po_line_id,receipt_line_id) -> receipt_lines(tenant_id,organization_id,po_line_id,id)',
    );
  });

  it('points a payment request line at an open item of the same entity', () => {
    expect(created.get('payment_request_lines')?.names.foreignKey).toContain(
      'payment_request_lines_open_item_fk (tenant_id,organization_id,open_item_id) -> open_items(tenant_id,organization_id,id)',
    );
  });

  it('stores no paid or balance column and no plaintext bank account number', () => {
    for (const shape of created.values()) {
      expect(shape.columns.filter((c) => /paid|balance/.test(c))).toEqual([]);
      expect(shape.columns.filter((c) => /account_number/.test(c))).toEqual([]);
    }
    expect(viewColumns().filter((c) => /paid|balance/.test(c))).toEqual([]);
  });
});
