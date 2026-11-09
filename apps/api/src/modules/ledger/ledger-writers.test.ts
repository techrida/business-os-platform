import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// LedgerService is the single writer of the AR/AP subledger (P3 plan, U0-B): no file outside modules/ledger may
// insert into, update or delete from open_items, open_item_allocations or posting_events, through Drizzle or raw
// SQL. Reads (open_item_balances, joins) stay allowed. Tests are not scanned: fixtures may seed rows directly.
// If this fails, call LedgerService (openItem, allocate, reverseAllocation, recordEvent) instead.

const SRC_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LEDGER_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** `.insert(openItems` and the like, line breaks allowed (prettier splits long chains). */
const DRIZZLE_WRITE =
  /\.(?:insert|update|delete)\(\s*(?:openItems|openItemAllocations|postingEvents)\b/g;
/** `INSERT INTO app.open_items`, `UPDATE "app"."posting_events"`, `DELETE FROM open_item_allocations`. */
const SQL_WRITE =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?app"?\s*\.\s*)?"?(?:open_items|open_item_allocations|posting_events)\b/gi;

function isTest(name: string): boolean {
  return /\.(test|spec)\.ts$/.test(name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !isTest(name))
    .map((name) => resolve(join(dir, name)));
}

function isLedgerFile(file: string): boolean {
  return file.startsWith(LEDGER_DIR + sep);
}

/** `file:line` of every ledger write. */
function findWrites(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of [DRIZZLE_WRITE, SQL_WRITE]) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push(`${relative(SRC_DIR, file).replaceAll('\\', '/')}:${line}`);
      }
    }
  }
  return hits;
}

describe('only modules/ledger writes the subledger tables', () => {
  const files = sourceFiles(SRC_DIR);

  it('scans the real source tree, tests excluded', () => {
    // A wrong root would scan nothing and pass.
    expect(files).toContain(join(SRC_DIR, 'platform/db/tx.ts'));
    expect(files).toContain(join(LEDGER_DIR, 'ledger.service.ts'));
    expect(files.some((file) => isTest(file))).toBe(false);
  });

  it('has no write to open_items, open_item_allocations or posting_events outside modules/ledger', () => {
    expect(findWrites(files.filter((file) => !isLedgerFile(file)))).toEqual([]);
  });

  it('sees the writes LedgerService makes (the patterns match real code)', () => {
    expect(findWrites([join(LEDGER_DIR, 'ledger.service.ts')]).length).toBeGreaterThanOrEqual(3);
  });

  it('would catch an offender', () => {
    const offenders = [
      'tx.insert(openItems).values(row)',
      'tx\n  .insert(\n    openItemAllocations,\n  )',
      'tx.update(postingEvents).set({})',
      'tx.delete(openItems)',
      'sql`INSERT INTO app.open_items (id) VALUES (${id})`',
      'UPDATE "app"."posting_events" SET payload = $1',
      'delete from open_item_allocations where id = $1',
    ];
    for (const sample of offenders) {
      expect(findWritesIn(sample), sample).toBeGreaterThan(0);
    }
    const fine = [
      'tx.select().from(openItems)',
      'tx.select().from(openItemBalances)',
      'tx.insert(openItemsArchive)',
      'SELECT * FROM app.open_item_balances',
    ];
    for (const sample of fine) {
      expect(findWritesIn(sample), sample).toBe(0);
    }
  });
});

function findWritesIn(text: string): number {
  return [...text.matchAll(DRIZZLE_WRITE), ...text.matchAll(SQL_WRITE)].length;
}
