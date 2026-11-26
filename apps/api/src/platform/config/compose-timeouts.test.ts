import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
} from '../db/tx-settings';

// The api and the worker read DB_LOCK_TIMEOUT_MS and DB_IDLE_IN_TX_TIMEOUT_MS from their environment, and a
// container sees only what compose passes: without these lines an operator's override never reaches either.
const compose = readFileSync(
  fileURLToPath(new URL('../../../../../infra/compose/compose.yaml', import.meta.url)),
  'utf8',
);

/** The service block of `name`: from its two-space header to the next one. */
function serviceBlock(name: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('compose passes the database timeouts', () => {
  it.each(['api', 'worker'])('%s gets all three, with the application defaults', (service) => {
    const block = serviceBlock(service);
    expect(block).toContain(
      `DB_LOCK_TIMEOUT_MS: \${DB_LOCK_TIMEOUT_MS:-${DEFAULT_LOCK_TIMEOUT_MS}}`,
    );
    expect(block).toContain(
      `DB_STATEMENT_TIMEOUT_MS: \${DB_STATEMENT_TIMEOUT_MS:-${DEFAULT_STATEMENT_TIMEOUT_MS}}`,
    );
    expect(block).toContain(
      `DB_IDLE_IN_TX_TIMEOUT_MS: \${DB_IDLE_IN_TX_TIMEOUT_MS:-${DEFAULT_IDLE_IN_TX_TIMEOUT_MS}}`,
    );
  });
});
