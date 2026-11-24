// The Drizzle schema of 0033_procurement_sourcing (src/schema/procurement.ts) must describe the SQL: the same
// tables and columns, and the same foreign keys (name, columns, parent table and parent columns), unique keys and
// indexes (name and columns) and checks (name only: CHECK bodies are not compared). tsc cannot see a drift between
// the two, and the API queries through Drizzle while the database enforces the SQL. No database needed: this
// reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/procurement-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { costCenters } from './schema/cost-centers.js';

import {
  PURCHASE_REQUEST_STATUSES,
  PURCHASE_REQUEST_TYPES,
  QUOTATION_SUBMISSION_STATUSES,
  RFQ_STATUSES,
  purchaseRequestLines,
  purchaseRequests,
  rfqVendors,
  rfqs,
  vendorComparisonScores,
  vendorQuotationLines,
  vendorQuotationSubmissions,
  vendorQuotations,
} from './schema/procurement.js';

const SQL_TEXT = [
  '0033_procurement_sourcing',
  '0036_purchase_request_serials',
  '0037_cost_centers',
  '0222_vendor_quotation_line_description',
]
  .map((name) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'))
  .join('\n');

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
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)"\s+ADD COLUMN "(\w+)" /g)) {
    shapeOf(m[1] ?? '').columns.push(m[2] ?? '');
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
  cost_centers: costCenters,
  purchase_requests: purchaseRequests,
  purchase_request_lines: purchaseRequestLines,
  rfqs,
  rfq_vendors: rfqVendors,
  vendor_quotations: vendorQuotations,
  vendor_quotation_lines: vendorQuotationLines,
  vendor_quotation_submissions: vendorQuotationSubmissions,
  vendor_comparison_scores: vendorComparisonScores,
};

/** The values of `col IN ('a', 'b')` in the SQL text, for the CHECK named `check`. */
function checkValues(check: string): string[] {
  const m = new RegExp(String.raw`CONSTRAINT "${check}" CHECK \("\w+" in \(([^)]*)\)\)`).exec(
    SQL_TEXT,
  );
  if (!m) throw new Error(`no IN-list check ${check}`);
  return (m[1] ?? '').split(',').map((v) => v.trim().replaceAll("'", ''));
}

describe('0033_procurement_sourcing and src/schema/procurement.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('create the same eight tables', () => {
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
    expect(checkValues('purchase_requests_status_check')).toEqual([...PURCHASE_REQUEST_STATUSES]);
    expect(checkValues('purchase_requests_request_type_check')).toEqual([
      ...PURCHASE_REQUEST_TYPES,
    ]);
    expect(checkValues('rfqs_status_check')).toEqual([...RFQ_STATUSES]);
    expect(checkValues('vendor_quotation_submissions_status_check')).toEqual([
      ...QUOTATION_SUBMISSION_STATUSES,
    ]);
  });

  it('invites a vendor only through its account in the same entity', () => {
    const fks = parsed.get('rfq_vendors')?.names.foreignKey ?? [];
    expect(fks).toContain(
      'rfq_vendors_vendor_account_fk (tenant_id,organization_id,vendor_id) -> vendor_accounts(tenant_id,organization_id,vendor_id)',
    );
  });

  it('scopes the cost centre FK to the acting entity and leaves projects for later', () => {
    const fks = parsed.get('purchase_requests')?.names.foreignKey ?? [];
    expect(fks).toContain(
      'purchase_requests_cost_center_fk (tenant_id,organization_id,cost_center_id) -> cost_centers(tenant_id,organization_id,id)',
    );
    expect(fks.filter((f) => /project/.test(f))).toEqual([]);
  });
});
