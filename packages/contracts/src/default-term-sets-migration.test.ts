import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TERM_PRESETS } from './document-style.js';

// Migration 0069 appends the app's default term sets to companies that already saved their own list. It embeds
// them as a frozen copy (a migration cannot import code). If DEFAULT_TERM_PRESETS changes, a new migration is
// needed for the new text; this test makes the drift visible instead of silent.
describe('migration 0069 default term sets', () => {
  it('embeds exactly DEFAULT_TERM_PRESETS', () => {
    const file = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../db/migrations/0069_default_term_sets_for_existing_tenants.sql',
    );
    const sql = readFileSync(file, 'utf8');
    const match = /jsonb_array_elements\('(.+?)'::jsonb\)/s.exec(sql);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(DEFAULT_TERM_PRESETS);
  });
});
