// The Drizzle schema of 0016_quotations plus the 0018 acceptance-evidence columns and the 0046 document_style column (src/schema/quotations.ts) must
// describe the SQL: the same tables and columns, and the same foreign keys (name, columns, parent table and parent columns), unique keys and indexes
// (name and columns) and checks (name only: CHECK bodies are not compared). It also pins the two rules the
// database enforces with plain lists, so the lists and the SQL cannot drift apart:
//   * the live statuses of the one_live_version index are QUOTATION_LIVE_STATUSES (contracts' liveStatuses);
//   * the freeze trigger compares exactly QUOTATION_VERSION_MATERIAL_COLUMNS, and every version column is either
//     material, always immutable, or listed as updatable after submit (a new column must be classified).
// No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/quotations-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import {
  QUOTATION_LIVE_STATUSES,
  QUOTATION_VERSION_IMMUTABLE_COLUMNS,
  QUOTATION_VERSION_MATERIAL_COLUMNS,
  QUOTATION_VERSION_UPDATABLE_COLUMNS,
  paymentTerms,
  quotationAcceptances,
  quotationLines,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersionEditors,
  quotationVersions,
  quotations,
  taxCodes,
} from './schema/quotations.js';

const SQL_TEXT = readFileSync(
  new URL('../migrations/0016_quotations.sql', import.meta.url),
  'utf8',
);
/** 0018 adds two columns (and their checks) to quotation_acceptances; the shape check reads both files. */
const ACCEPTANCE_EVIDENCE_SQL = readFileSync(
  new URL('../migrations/0018_quotation_acceptance_evidence.sql', import.meta.url),
  'utf8',
);

/** 0046 adds the write-once document_style column and its own guard trigger. */
const DOCUMENT_STYLE_SQL = readFileSync(
  new URL('../migrations/0046_quotation_version_document_style.sql', import.meta.url),
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

/** Constraints Drizzle 0.45 cannot model; each is asserted on its own below. */
const SQL_ONLY = ['tax_codes_no_overlap'];

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
  for (const m of text.matchAll(/ALTER TABLE "app"\."(\w+)" ADD COLUMN "(\w+)" /g)) {
    shapeOf(m[1] ?? '').columns.push(m[2] ?? '');
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
  tax_codes: taxCodes,
  payment_terms: paymentTerms,
  quotations,
  quotation_versions: quotationVersions,
  quotation_lines: quotationLines,
  quotation_tax_summary: quotationTaxSummary,
  quotation_version_editors: quotationVersionEditors,
  quotation_acceptances: quotationAcceptances,
  quotation_status_history: quotationStatusHistory,
};

/** The S1 tables 0016 only alters (their Drizzle tables in crm.ts mirror 0015 alone). */
const S1_TABLES = ['party_accounts', 'opportunities', 'activities'];

/** The body of `CREATE FUNCTION "app"."<name>"() ... $$ ... $$;`. */
function functionBody(name: string): string {
  const m = new RegExp(
    `CREATE FUNCTION "app"\\."${name}"\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`,
  ).exec(SQL_TEXT);
  if (!m) throw new Error(`no function ${name} in 0016`);
  return m[1] ?? '';
}

describe('0016_quotations and src/schema/quotations.ts', () => {
  const parsed = parseSql(`${SQL_TEXT}
${ACCEPTANCE_EVIDENCE_SQL}
${DOCUMENT_STYLE_SQL}`);
  // 0045 writes its check unquoted (app.quotation_versions), which parseSql does not read. The Drizzle table
  // declares it, so name it here instead of leaving the shape test red.
  parsed
    .get('quotation_versions')
    ?.names.check.push('quotation_versions_amount_discount_precision_check');

  it('create the same nine tables, and alter only the three S1 tables', () => {
    const created = [...SQL_TEXT.matchAll(/CREATE TABLE "app"\."(\w+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(Object.keys(DRIZZLE).sort());
    expect([...parsed.keys()].sort()).toEqual([...Object.keys(DRIZZLE), ...S1_TABLES].sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, keys, checks and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    expect(sorted(drizzleShape(table))).toEqual(sorted(parsed.get(name) ?? empty()));
  });

  it('adds the three foreign keys S1 left for S2, composite with the entity where the parent is entity-owned', () => {
    expect(parsed.get('party_accounts')?.names.foreignKey).toEqual([
      'party_accounts_payment_term_fk (tenant_id,payment_term_id) -> payment_terms(tenant_id,id)',
    ]);
    expect(parsed.get('opportunities')?.names.foreignKey).toEqual([
      'opportunities_won_quotation_version_fk (tenant_id,organization_id,won_quotation_version_id) -> quotation_versions(tenant_id,organization_id,id)',
    ]);
    expect(parsed.get('activities')?.names.foreignKey).toEqual([
      'activities_quotation_fk (tenant_id,organization_id,quotation_id) -> quotations(tenant_id,organization_id,id)',
    ]);
  });

  it('forbids overlapping tax-code periods per (tenant_id, code) with an EXCLUDE constraint', () => {
    expect(SQL_TEXT).toMatch(/CREATE EXTENSION IF NOT EXISTS "btree_gist"/);
    expect(SQL_TEXT).toContain(
      `ALTER TABLE "app"."tax_codes" ADD CONSTRAINT "tax_codes_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "code" WITH =, daterange("effective_from", "effective_to", '[)') WITH &&);`,
    );
  });

  it('defines one_live_version over exactly QUOTATION_LIVE_STATUSES', () => {
    const m =
      /CREATE UNIQUE INDEX "one_live_version" ON "app"\."quotation_versions" USING btree \("tenant_id", "quotation_id"\) WHERE "status" IN \(([^)]*)\);/.exec(
        SQL_TEXT,
      );
    expect(m).not.toBeNull();
    const statuses = (m?.[1] ?? '').split(',').map((s) => s.trim().replaceAll("'", ''));
    expect(statuses).toEqual([...QUOTATION_LIVE_STATUSES]);
  });

  it('freezes exactly QUOTATION_VERSION_MATERIAL_COLUMNS once a version leaves draft/returned', () => {
    const body = functionBody('quotation_versions_guard');
    const frozen = body.split('-- frozen:')[1] ?? '';
    const compared = [...frozen.matchAll(/OLD\."(\w+)" IS DISTINCT FROM NEW\."\1"/g)].map(
      (m) => m[1],
    );
    expect(compared.sort()).toEqual([...QUOTATION_VERSION_MATERIAL_COLUMNS].sort());
    const identity = body.split('-- identity:')[1]?.split('-- transitions:')[0] ?? '';
    const immutable = [...identity.matchAll(/OLD\."(\w+)" IS DISTINCT FROM NEW\."\1"/g)].map(
      (m) => m[1],
    );
    expect(immutable.sort()).toEqual([...QUOTATION_VERSION_IMMUTABLE_COLUMNS].sort());
  });

  it('classifies every quotation_versions column exactly once', () => {
    const all = [
      ...QUOTATION_VERSION_IMMUTABLE_COLUMNS,
      ...QUOTATION_VERSION_MATERIAL_COLUMNS,
      ...QUOTATION_VERSION_UPDATABLE_COLUMNS,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...(parsed.get('quotation_versions')?.columns ?? [])].sort());
  });

  it('guards lines, the tax summary and editors, and keeps acceptances and history append-only', () => {
    for (const table of ['quotation_lines', 'quotation_tax_summary', 'quotation_version_editors']) {
      expect(SQL_TEXT).toContain(
        `CREATE TRIGGER "${table}_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."${table}"`,
      );
    }
    for (const table of ['quotation_acceptances', 'quotation_status_history']) {
      expect(SQL_TEXT).toContain(
        `CREATE TRIGGER "${table}_append_only" BEFORE UPDATE OR DELETE ON "app"."${table}"`,
      );
    }
  });

  it('audits every table it creates', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'\);/g)].map(
      (m) => m[1],
    );
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('0018 adds the name and the evidence document ids to acceptances without touching the append-only trigger', () => {
    expect(ACCEPTANCE_EVIDENCE_SQL).toContain(
      `ALTER TABLE "app"."quotation_acceptances" ADD COLUMN "accepted_by_name" text;`,
    );
    expect(ACCEPTANCE_EVIDENCE_SQL).toContain(
      `ALTER TABLE "app"."quotation_acceptances" ADD COLUMN "evidence_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;`,
    );
    expect(ACCEPTANCE_EVIDENCE_SQL).toMatch(/char_length\("accepted_by_name"\) <= 200/);
    expect(ACCEPTANCE_EVIDENCE_SQL).not.toMatch(/TRIGGER|quotation_append_only/);
  });

  it('0046 keeps document_style out of the freeze list and guards it with its own write-once trigger', () => {
    expect(QUOTATION_VERSION_UPDATABLE_COLUMNS).toContain('document_style');
    expect(QUOTATION_VERSION_MATERIAL_COLUMNS).not.toContain('document_style');
    // The main guard is untouched: 0046 neither redefines it nor lists the column in a frozen comparison.
    expect(DOCUMENT_STYLE_SQL).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "app"\."quotation_versions_guard"/,
    );
    expect(functionBody('quotation_versions_guard')).not.toContain('document_style');
    expect(DOCUMENT_STYLE_SQL).toContain(
      `CREATE TRIGGER "quotation_versions_document_style_guard" BEFORE INSERT OR UPDATE ON "app"."quotation_versions"`,
    );
    // Once set it never changes; it is set only after approval (the gate is OLD.status, like the main guard).
    expect(DOCUMENT_STYLE_SQL).toContain(
      `NEW."document_style" IS DISTINCT FROM OLD."document_style"`,
    );
    expect(DOCUMENT_STYLE_SQL).toContain(
      `NEW."document_style" IS NOT NULL AND OLD."status" IN ('draft', 'returned')`,
    );
  });

  it('exports the quotation tables from the package', () => {
    expect(api.quotations).toBe(quotations);
    expect(api.quotationVersions).toBe(quotationVersions);
    expect(api.taxCodes).toBe(taxCodes);
  });
});
