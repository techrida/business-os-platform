// Integration test of the read-modify-write helper behind the term-preset routes: a real postgres:16-alpine
// started by Testcontainers. Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/settings/document-settings/document-settings.integration.test.ts
//
// What a fake cannot show: with the advisory lock taken BEFORE the read (SettingsService.getLocked), ten admins
// adding a preset at the same moment all keep their preset, in ten consecutive versions. Without the lock two
// writers would read the same list and the later write would drop the earlier one. Setup is the same as
// settings.integration.test.ts: create the roles, migrate as bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';

import { type TermPreset, TermPresetListSchema } from '@bos/contracts';
import { createTenantWithEntity, runMigrations } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../../db/db.module';
import { type TxScope, systemActor, withTx } from '../../db/tx';
import { SettingsService } from '../settings.service';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let settings: SettingsService;

async function newScope(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 12 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  settings = new SettingsService(db);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
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
  it('keeps every preset of 10 simultaneous writers, in 10 consecutive versions', async () => {
    const scope = await newScope();
    const names = Array.from({ length: 10 }, (_, i) => `option ${i}`);
    const results = await Promise.all(names.map((name) => appendPreset(scope, name)));

    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const stored = await settings.get(scope, 'quotation.term_presets');
    expect(stored.map((p) => p.name).sort()).toEqual([...names].sort());
  });

  it('getLocked on a never-written key answers the default with version null', async () => {
    const scope = await newScope();
    const read = await withTx(db, scope, systemActor('test'), (tx) =>
      settings.getLocked(tx, 'quotation.term_presets'),
    );
    expect(read).toEqual({ value: [], version: null });
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
    expect(secondRead?.map((p) => p.name)).toEqual(['first']);
    const stored = await settings.get(scope, 'quotation.term_presets');
    expect(stored.map((p) => p.name)).toEqual(['first', 'second']);
  });
});
