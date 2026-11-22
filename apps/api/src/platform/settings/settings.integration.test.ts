// Integration test for SettingsService and MoneyService: a real postgres:16-alpine started by Testcontainers.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/settings.integration.test.ts
//
// Version numbers under concurrency, the unique-violation-free duplicate rate and the Kathmandu-midnight
// rate lookup only show up against a real database. Setup is the same as numbering.service.test.ts: create
// the roles, migrate as bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';

import { createTenantWithEntity, organizations } from '@bos/db';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../db/tx';
import { MoneyService } from './money.service';
import { NumberingService } from './numbering.service';
import { SETTING_DEFAULTS, SettingsService } from './settings.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let settingsService: SettingsService;
let money: MoneyService;

/** Each describe block uses its own tenant, so no test sees another's rows. */
async function newScope(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

/** A second legal entity in the tenant of `scope`, to act as when a test needs another entity. */
async function addEntity(scope: TxScope): Promise<TxScope> {
  const organizationId = randomUUID();
  const other = { tenantId: scope.tenantId, organizationId };
  await withTx(db, other, systemActor('test'), (tx) =>
    tx.insert(organizations).values({
      id: organizationId,
      tenantId: scope.tenantId,
      organizationId,
      code: `E${organizationId.slice(0, 8)}`,
      name: 'Second entity',
      legalName: 'Second entity Pvt. Ltd.',
    }),
  );
  return other;
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  // An idle client that Postgres drops during teardown (57P01) emits 'error' on the pool; unhandled,
  // vitest counts it as a failure (seen once in CI). The app's pool ignores it the same way.
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  settingsService = new SettingsService(db);
  money = new MoneyService(db, settingsService);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('SettingsService', () => {
  it('returns the default until a version exists, then the latest version', async () => {
    const scope = await newScope();
    const system = systemActor('test');

    expect(await settingsService.get(scope, 'tax.vat_rate')).toBe('13');
    expect(await settingsService.getCurrent(scope, 'tax.vat_rate')).toEqual({
      value: '13',
      version: null,
    });
    expect(await settingsService.get(scope, 'currency.enabled')).toEqual(['NPR', 'INR', 'USD']);

    expect(
      await withTx(db, scope, system, (tx) => settingsService.set(tx, 'tax.vat_rate', '15')),
    ).toEqual({
      version: 1,
    });
    expect(
      await withTx(db, scope, system, (tx) => settingsService.set(tx, 'tax.vat_rate', '10')),
    ).toEqual({
      version: 2,
    });

    expect(await settingsService.get(scope, 'tax.vat_rate')).toBe('10');
    expect(await settingsService.getCurrent(scope, 'tax.vat_rate')).toEqual({
      value: '10',
      version: 2,
    });
    // Another key is untouched.
    expect(await settingsService.get(scope, 'numbering.memo_prefix')).toBe(
      SETTING_DEFAULTS['numbering.memo_prefix'],
    );
  });

  it('lists the history newest first and records the user who made each change', async () => {
    const scope = await newScope();
    const userId = randomUUID();
    const user: Actor = { kind: 'user', id: userId, correlationId: 'corr-1' };

    await withTx(db, scope, user, (tx) => settingsService.set(tx, 'numbering.memo_prefix', 'MEMO'));
    // A system actor id is not a uuid, so created_by becomes NULL instead of failing the insert.
    await withTx(db, scope, systemActor('seed'), (tx) =>
      settingsService.set(tx, 'numbering.memo_prefix', 'NOTE'),
    );

    const history = await settingsService.history(scope, 'numbering.memo_prefix');
    expect(history.map((h) => [h.version, h.value, h.createdBy])).toEqual([
      [2, 'NOTE', null],
      [1, 'MEMO', userId],
    ]);
    expect(history[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('writes the company PAN and phones strictly, and still reads a row written before the rules (FX8)', async () => {
    const scope = await newScope();
    const system = systemActor('test');
    const profile = { ...SETTING_DEFAULTS['entity.profile'] };

    await expect(
      withTx(db, scope, system, (tx) => settingsService.set(tx, 'entity.pan_vat_no', '12345')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withTx(db, scope, system, (tx) =>
        settingsService.set(tx, 'entity.profile', { ...profile, phones: ['01-4123456'] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withTx(db, scope, system, (tx) =>
        settingsService.set(tx, 'entity.profile', { ...profile, panVatNo: 'AB-1234' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await settingsService.history(scope, 'entity.pan_vat_no')).toEqual([]);
    expect(await settingsService.history(scope, 'entity.profile')).toEqual([]);

    await withTx(db, scope, system, async (tx) => {
      await settingsService.set(tx, 'entity.pan_vat_no', '301234567');
      await settingsService.set(tx, 'entity.profile', {
        ...profile,
        phones: ['+9779812345678', '+97714123456'],
        panVatNo: '301234567',
      });
    });
    expect(await settingsService.get(scope, 'entity.pan_vat_no')).toBe('301234567');

    // A row written before the rules: GET returns it as stored instead of failing.
    await withTx(db, scope, system, (tx) =>
      tx.execute(sql`
        INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
        VALUES (${scope.tenantId}::uuid, ${scope.organizationId}::uuid, 'entity.pan_vat_no', 9,
                '"AB-1234"'::jsonb)`),
    );
    expect(await settingsService.get(scope, 'entity.pan_vat_no')).toBe('AB-1234');
  });

  it('rejects an invalid value and writes nothing', async () => {
    const scope = await newScope();
    const system = systemActor('test');

    await expect(
      withTx(db, scope, system, (tx) => settingsService.set(tx, 'tax.vat_rate', '150')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withTx(db, scope, system, (tx) => settingsService.set(tx, 'currency.enabled', ['INR'])),
    ).rejects.toThrow(/NPR must stay enabled/);
    await expect(
      withTx(db, scope, system, (tx) => settingsService.set(tx, 'numbering.memo_prefix', 'm')),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await settingsService.history(scope, 'tax.vat_rate')).toEqual([]);
    expect(await settingsService.history(scope, 'currency.enabled')).toEqual([]);
  });

  it('stores the parsed value, so schema defaults are filled in', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      settingsService.set(tx, 'approvals.sla_defaults', {}),
    );
    expect(await settingsService.get(scope, 'approvals.sla_defaults')).toEqual({
      remindAfterHours: 24,
      escalateAfterHours: 72,
      escalateTo: { role: 'founder' },
    });
  });

  it('gives 10 concurrent writers 10 distinct, consecutive versions (the advisory lock)', async () => {
    const scope = await newScope();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withTx(db, scope, systemActor('test'), (tx) =>
          settingsService.set(tx, 'tax.vat_rate', String(i + 1)),
        ),
      ),
    );
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('keeps one tenant out of another tenant history', async () => {
    const a = await newScope();
    const b = await newScope();
    await withTx(db, a, systemActor('test'), (tx) => settingsService.set(tx, 'tax.vat_rate', '5'));
    expect(await settingsService.get(b, 'tax.vat_rate')).toBe('13');
  });

  it('refuses a transaction that was not opened with withTx', async () => {
    await expect(
      db.transaction((tx) => settingsService.set(tx, 'tax.vat_rate', '15')),
    ).rejects.toThrow(/withTx/);
  });

  it('lists number series for the admin screen', async () => {
    const scope = await newScope();
    expect(await settingsService.listNumberSeries(scope)).toEqual([]);

    // Taking a number creates the counter row, exactly as a memo would.
    const numbering = new NumberingService();
    await withTx(db, scope, systemActor('test'), (tx) =>
      numbering.next(tx, 'MEMO', new Date('2025-07-16T18:15:00Z')),
    );
    expect(await settingsService.listNumberSeries(scope)).toEqual([
      { key: 'MEMO', fiscalYear: '2082/83', prefix: 'MEMO', nextValue: 2, pad: 5 },
    ]);
  });
});

describe('MoneyService', () => {
  // 2025-07-16T18:15Z is 2025-07-17 00:00 in Kathmandu.
  const KTM_MIDNIGHT = new Date('2025-07-16T18:15:00Z');
  const ONE_MINUTE_BEFORE = new Date('2025-07-16T18:14:00Z');

  it('converts NPR at rate 1 without any rate row', async () => {
    const scope = await newScope();
    expect(
      await money.toNprSnapshot(db, scope, { amount: '1250.50', currency: 'NPR' }, KTM_MIDNIGHT),
    ).toEqual({ amountNpr: '1250.50', rate: '1', rateSource: 'NPR', rateDate: '2025-07-17' });
  });

  it('answers 409 for USD when no rate exists', async () => {
    const scope = await newScope();
    const attempt = money.toNprSnapshot(
      db,
      scope,
      { amount: '10.00', currency: 'USD' },
      KTM_MIDNIGHT,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: { code: 'conflict', message: 'No NPR rate for USD on or before 2025-07-17' },
    });
  });

  it('finds a rate entered while acting in entity E1 when acting in E2 of the same tenant', async () => {
    const e1 = await newScope();
    const e2 = await addEntity(e1);
    await withTx(db, e1, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '133.00', '2025-07-10', 'manual'),
    );

    // A rate is a market fact of the tenant (ADR 0027 section 7), so E2 sees the row E1 entered.
    expect(
      await money.toNprSnapshot(db, e2, { amount: '100.00', currency: 'USD' }, KTM_MIDNIGHT),
    ).toMatchObject({ amountNpr: '13300.00', rateDate: '2025-07-10' });
    expect(await money.listRates(e2, { limit: 10 })).toHaveLength(1);

    // And the rate is one row per tenant: E2 cannot enter the same day again.
    await expect(
      withTx(db, e2, systemActor('test'), (tx) =>
        money.setRate(tx, 'USD', '140.00', '2025-07-10', 'manual'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('turns INR 1000.00 into NPR 1600.00 at the 1.6 peg', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'INR', '1.6', '2025-07-10', 'NRB peg'),
    );
    expect(
      await money.toNprSnapshot(db, scope, { amount: '1000.00', currency: 'INR' }, KTM_MIDNIGHT),
    ).toEqual({ amountNpr: '1600.00', rate: '1.6', rateSource: 'NRB peg', rateDate: '2025-07-10' });
  });

  it('rounds half up to 2 places and uses all 6 rate decimals', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '133.123456', '2025-07-10', 'manual'),
    );
    // 0.05 * 133.123456 = 6.6561728 -> 6.66
    expect(
      (await money.toNprSnapshot(db, scope, { amount: '0.05', currency: 'USD' }, KTM_MIDNIGHT))
        .amountNpr,
    ).toBe('6.66');
  });

  it('looks the rate up by the Kathmandu date: a 17 July rate applies from local midnight', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await money.setRate(tx, 'USD', '133.00', '2025-07-10', 'manual');
      await money.setRate(tx, 'USD', '135.50', '2025-07-17', 'manual');
    });
    const usd = { amount: '100.00', currency: 'USD' } as const;

    // One minute earlier it is still 16 July in Kathmandu: the 10 July rate (latest on or before) applies.
    const before = await money.toNprSnapshot(db, scope, usd, ONE_MINUTE_BEFORE);
    expect(before).toMatchObject({ amountNpr: '13300.00', rateDate: '2025-07-10' });

    const at = await money.toNprSnapshot(db, scope, usd, KTM_MIDNIGHT);
    expect(at).toMatchObject({ amountNpr: '13550.00', rate: '135.5', rateDate: '2025-07-17' });
  });

  it('answers 409 when the only rate is dated after the Kathmandu day', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '135.50', '2025-07-17', 'manual'),
    );
    await expect(
      money.toNprSnapshot(db, scope, { amount: '1.00', currency: 'USD' }, ONE_MINUTE_BEFORE),
    ).rejects.toThrow(/No NPR rate for USD on or before 2025-07-16/);
  });

  it('answers 409 fx_rate_stale for a rate 8 days old, and takes a rate exactly 7 days old', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '133.00', '2025-07-09', 'manual'),
    );
    const usd = { amount: '100.00', currency: 'USD' } as const;

    // 2025-07-09 is 8 days before the Kathmandu day 2025-07-17 and the default limit is 7.
    const attempt = money.toNprSnapshot(db, scope, usd, KTM_MIDNIGHT);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: {
        code: 'fx_rate_stale',
        details: { currency: 'USD', rateDate: '2025-07-09', maxAgeDays: 7 },
      },
    });

    // One day earlier it is exactly 7 days old: still fresh.
    expect(await money.toNprSnapshot(db, scope, usd, ONE_MINUTE_BEFORE)).toMatchObject({
      amountNpr: '13300.00',
      rateDate: '2025-07-09',
    });
  });

  it('reads fx.max_rate_age_days from the settings: raising it to 30 accepts the 8-day-old rate', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await money.setRate(tx, 'USD', '133.00', '2025-07-09', 'manual');
      await settingsService.set(tx, 'fx.max_rate_age_days', 30);
    });
    expect(
      await money.toNprSnapshot(db, scope, { amount: '1.00', currency: 'USD' }, KTM_MIDNIGHT),
    ).toMatchObject({ rateDate: '2025-07-09' });
  });

  it('can snapshot inside a transaction', async () => {
    const scope = await newScope();
    const snapshot = await withTx(db, scope, systemActor('test'), async (tx) => {
      await money.setRate(tx, 'INR', '1.6', '2025-07-10', 'NRB peg');
      return money.toNprSnapshot(tx, scope, { amount: '10.00', currency: 'INR' }, KTM_MIDNIGHT);
    });
    expect(snapshot.amountNpr).toBe('16.00');
  });

  it('answers 409 for a duplicate rate and leaves the transaction usable', async () => {
    const scope = await newScope();
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '133.00', '2025-07-10', 'manual'),
    );

    // The caller can catch the 409 and keep using the same transaction: a raw unique violation would have
    // aborted it, and the next statement would fail with "current transaction is aborted".
    const rows = await withTx(db, scope, systemActor('test'), async (tx) => {
      await expect(
        money.setRate(tx, 'USD', '140.00', '2025-07-10', 'manual'),
      ).rejects.toBeInstanceOf(ConflictException);
      return money.listRates(scope, { limit: 10 });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      currency: 'USD',
      rateNpr: '133.000000',
      rateDate: '2025-07-10',
    });
  });

  it('records the entering user, or NULL for a system actor', async () => {
    const scope = await newScope();
    const userId = randomUUID();
    await withTx(db, scope, { kind: 'user', id: userId, correlationId: 'c-2' }, (tx) =>
      money.setRate(tx, 'USD', '133.00', '2025-07-10', 'manual'),
    );
    await withTx(db, scope, systemActor('seed'), (tx) =>
      money.setRate(tx, 'INR', '1.6', '2025-07-10', 'NRB peg'),
    );
    const rows = await money.listRates(scope, { limit: 10 });
    expect(rows.map((r) => [r.currency, r.enteredBy]).sort()).toEqual([
      ['INR', null],
      ['USD', userId],
    ]);
    expect(await money.listRates(scope, { currency: 'INR', limit: 10 })).toHaveLength(1);
  });

  it('refuses a transaction that was not opened with withTx', async () => {
    await expect(
      db.transaction((tx) => money.setRate(tx, 'USD', '133.00', '2025-07-10', 'manual')),
    ).rejects.toThrow(/withTx/);
  });
});
