// Migration 0107 (F1-Q28) and its Drizzle table (src/schema/quotations.ts) describe the same thing: the same
// columns, the same named foreign keys, unique keys and checks, an append-only trigger and the audit hook. The
// tenancy and audit checkers (check-tenancy.test.ts, check-audit.test.ts) cover the table on a migrated database.
// No database needed: this reads the migration file.
// Run with: pnpm --filter @bos/db exec vitest run src/quotation-evidence-confirmations-schema.test.ts
import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { quotationEvidenceConfirmations } from './schema/quotations.js';

const TABLE = 'quotation_evidence_confirmations';
const SQL_TEXT = readFileSync(
  new URL('../migrations/0107_quotation_evidence_confirmations.sql', import.meta.url),
  'utf8',
);

/** The column names of the CREATE TABLE, in order. */
function sqlColumns(): string[] {
  const body = new RegExp(`CREATE TABLE "app"\\."${TABLE}" \\(([\\s\\S]*?)\\n\\);`).exec(
    SQL_TEXT,
  )?.[1];
  if (body === undefined) throw new Error(`no CREATE TABLE ${TABLE}`);
  return [...body.matchAll(/^\t"(\w+)" /gm)].map((m) => m[1]!);
}

const constraintNames = (): string[] =>
  [...SQL_TEXT.matchAll(/CONSTRAINT "(\w+)"/g)].map((m) => m[1]!).sort();

describe('0107_quotation_evidence_confirmations and its Drizzle table', () => {
  const config = getTableConfig(quotationEvidenceConfirmations);

  it('has the same columns', () => {
    expect(config.columns.map((c) => c.name).sort()).toEqual(sqlColumns().sort());
  });

  it('names the same keys and checks', () => {
    const drizzle = [
      ...config.foreignKeys.map((fk) => fk.getName()),
      ...config.uniqueConstraints.map((u) => u.name ?? ''),
      ...config.checks.map((c) => c.name),
    ];
    expect(drizzle.sort()).toEqual(constraintNames());
  });

  it('is append-only and audited', () => {
    expect(SQL_TEXT).toContain(
      `CREATE TRIGGER "${TABLE}_append_only" BEFORE UPDATE OR DELETE ON "app"."${TABLE}"`,
    );
    expect(SQL_TEXT).toContain(`SELECT audit.attach('app.${TABLE}');`);
  });
});
