// Integration test of the read-modify-write helper behind the term-preset routes: a real postgres:16-alpine
// started by Testcontainers. Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/settings/document-settings/document-settings.integration.test.ts
//
// What a fake cannot show: with the advisory lock taken BEFORE the read (SettingsService.getLocked), ten admins
// adding a preset at the same moment all keep their preset, in ten consecutive versions. Without the lock two
// writers would read the same list and the later write would drop the earlier one. Setup is the same as
// settings.integration.test.ts: create the roles, migrate as bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';

import { DEFAULT_TERM_PRESETS, type TermPreset, TermPresetListSchema } from '@bos/contracts';
import { createTenantWithEntity } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../../db/db.module';
import { type TxScope, systemActor, withTx } from '../../db/tx';
import { SettingsService } from '../settings.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

/** A never-written key reads the app's own sets, so every list in these tests starts with them. */
const DEFAULT_NAMES = DEFAULT_TERM_PRESETS.map((p) => p.name);

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let settings: SettingsService;

async function newScope(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 12 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  settings = new SettingsService(db);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

/** The service's own read-modify-write: lock + read, append one preset, validate, set. */
function appendPreset(scope: TxScope, name: string): Promise<{ version: number }> {
  return withTx(db, scope, systemActor('test'), async (tx) => {
    const { value } = await settings.getLocked(tx, 'quotation.term_presets');
    const next: TermPreset[] = [
      ...value,
      { id: randomUUID(), kind: 'scope', name, body: `body of ${name}` },
    ];
    return settings.set(tx, 'quotation.term_presets', TermPresetListSchema.parse(next));
  });
}

describe('term presets read-modify-write', () => {
  it('keeps every preset of 10 simultaneous writers (and the defaults), in 10 consecutive versions', async () => {
    const scope = await newScope();
    const names = Array.from({ length: 10 }, (_, i) => `option ${i}`);
    const results = await Promise.all(names.map((name) => appendPreset(scope, name)));

    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const stored = await settings.get(scope, 'quotation.term_presets');
    // The 4 app defaults the first writer read, plus the 10 presets: nothing was dropped, nothing doubled.
    expect(stored).toHaveLength(DEFAULT_NAMES.length + names.length);
    expect(stored.map((p) => p.name).sort()).toEqual([...DEFAULT_NAMES, ...names].sort());
  });

  it('getLocked on a never-written key answers the default with version null', async () => {
    const scope = await newScope();
    const read = await withTx(db, scope, systemActor('test'), (tx) =>
      settings.getLocked(tx, 'quotation.term_presets'),
    );
    expect(read).toEqual({ value: DEFAULT_TERM_PRESETS, version: null });
  });

  it('a second writer waits for the first to commit, then reads what the first wrote', async () => {
    const scope = await newScope();
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstHasLock: () => void = () => undefined;
    const firstLocked = new Promise<void>((resolve) => (firstHasLock = resolve));

    const first = withTx(db, scope, systemActor('test'), async (tx) => {
      const { value } = await settings.getLocked(tx, 'quotation.term_presets');
      firstHasLock();
      await firstMayCommit;
      const next = [
        ...value,
        { id: randomUUID(), kind: 'scope' as const, name: 'first', body: 'a' },
      ];
      return settings.set(tx, 'quotation.term_presets', next);
    });
    await firstLocked;

    let secondRead: TermPreset[] | undefined;
    const second = withTx(db, scope, systemActor('test'), async (tx) => {
      const { value } = await settings.getLocked(tx, 'quotation.term_presets');
      secondRead = value;
      return settings.set(tx, 'quotation.term_presets', [
        ...value,
        { id: randomUUID(), kind: 'scope' as const, name: 'second', body: 'b' },
      ]);
    });

    // Give the second writer time to reach the lock; it must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondRead).toBeUndefined();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondRead?.map((p) => p.name)).toEqual([...DEFAULT_NAMES, 'first']);
    const stored = await settings.get(scope, 'quotation.term_presets');
    expect(stored.map((p) => p.name)).toEqual([...DEFAULT_NAMES, 'first', 'second']);
  });
});

describe('default term preset', () => {
  /** The same write the service makes for a default: lock, read, move the default, validate, set. */
  function setDefault(scope: TxScope, id: string): Promise<{ version: number }> {
    return withTx(db, scope, systemActor('test'), async (tx) => {
      const { value } = await settings.getLocked(tx, 'quotation.term_presets');
      const target = value.find((p) => p.id === id) as TermPreset;
      const next = value.map((p) => {
        if (p.id === id) return { ...p, isDefault: true };
        if (p.kind === target.kind) return { ...p, isDefault: undefined };
        return p;
      });
      return settings.set(tx, 'quotation.term_presets', TermPresetListSchema.parse(next));
    });
  }

  it('keeps one default per kind and never shows one tenant another tenant default', async () => {
    const one = await newScope();
    const two = await newScope();
    const [first, second] = DEFAULT_TERM_PRESETS.filter((p) => p.kind === 'terms_conditions');
    await setDefault(one, (first as TermPreset).id);
    await setDefault(one, (second as TermPreset).id);

    const stored = await settings.get(one, 'quotation.term_presets');
    expect(
      stored.filter((p) => p.kind === 'terms_conditions' && p.isDefault === true).map((p) => p.id),
    ).toEqual([(second as TermPreset).id]);

    const other = await settings.get(two, 'quotation.term_presets');
    expect(other.some((p) => p.isDefault === true)).toBe(false);

    // The stored list refuses two defaults of one kind, whoever writes it.
    await expect(
      withTx(db, one, systemActor('test'), (tx) =>
        settings.set(
          tx,
          'quotation.term_presets',
          stored.map((p) => (p.kind === 'terms_conditions' ? { ...p, isDefault: true } : p)),
        ),
      ),
    ).rejects.toThrow();
  });
});
