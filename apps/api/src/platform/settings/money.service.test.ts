// Unit test of the FX staleness rule in MoneyService.toNprSnapshot. The database is a fake that returns
// the one rate row a test wants; the real integration cases are in settings.integration.test.ts.
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import { MoneyService, shiftDay } from './money.service';
import type { SettingsService } from './settings.service';

const SCOPE = { tenantId: 'tenant-1', organizationId: 'entity-1' };
/** 2026-11-09 12:00 in Kathmandu (06:15Z). */
const ON = new Date('2026-11-09T06:15:00Z');

/** An executor whose rate query returns `rows`. */
function executor(rows: { rate: string; source: string | null; rateDate: string }[]) {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => rows };
  return { select: () => chain } as unknown as Pick<Db, 'select'>;
}

function service(maxAgeDays: number | undefined = 7) {
  const asked: string[] = [];
  const settings = {
    get: (_scope: unknown, key: string) => {
      asked.push(key);
      return Promise.resolve(maxAgeDays);
    },
  } as unknown as SettingsService;
  return { money: new MoneyService({} as Db, settings), asked };
}

const usd = { amount: '100.00', currency: 'USD' } as const;
const row = (rateDate: string) => ({ rate: '133.500000', source: 'manual', rateDate });

describe('shiftDay', () => {
  it.each([
    ['2026-11-09', 7, '2026-11-02'],
    ['2026-11-02', 7, '2026-10-26'],
    ['2026-03-03', 7, '2026-02-24'],
    ['2024-03-03', 7, '2024-02-25'],
    ['2026-01-03', 7, '2025-12-27'],
  ])('%s minus %i days is %s', (day, days, expected) => {
    expect(shiftDay(day, -days)).toBe(expected);
  });
});

describe('MoneyService.toNprSnapshot staleness', () => {
  it('refuses a rate dated today minus 8 days with 409 fx_rate_stale and details', async () => {
    const { money } = service();
    const attempt = money.toNprSnapshot(executor([row('2026-11-01')]), SCOPE, usd, ON);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: {
        code: 'fx_rate_stale',
        details: { currency: 'USD', rateDate: '2026-11-01', maxAgeDays: 7 },
      },
    });
  });

  it('accepts a rate exactly 7 days old and one from today', async () => {
    const { money } = service();
    expect(await money.toNprSnapshot(executor([row('2026-11-02')]), SCOPE, usd, ON)).toMatchObject({
      amountNpr: '13350.00',
      rateDate: '2026-11-02',
    });
    expect(await money.toNprSnapshot(executor([row('2026-11-09')]), SCOPE, usd, ON)).toMatchObject({
      rateDate: '2026-11-09',
    });
  });

  it('reads the limit from the fx.max_rate_age_days setting', async () => {
    const { money, asked } = service(30);
    expect(await money.toNprSnapshot(executor([row('2026-10-15')]), SCOPE, usd, ON)).toMatchObject({
      rateDate: '2026-10-15',
    });
    expect(asked).toEqual(['fx.max_rate_age_days']);

    const tight = service(1);
    await expect(
      tight.money.toNprSnapshot(executor([row('2026-11-07')]), SCOPE, usd, ON),
    ).rejects.toMatchObject({ response: { code: 'fx_rate_stale' } });
  });

  it('measures the age on the Kathmandu day, not the UTC day', async () => {
    const { money } = service();
    // 2026-11-08T19:00Z is already 9 November in Nepal, so 2026-11-02 is exactly 7 days old...
    const lateUtc = new Date('2026-11-08T19:00:00Z');
    expect(
      await money.toNprSnapshot(executor([row('2026-11-02')]), SCOPE, usd, lateUtc),
    ).toMatchObject({
      rateDate: '2026-11-02',
    });
    // ...and 2026-11-01 is one day too old, though it is 7 days before the UTC date.
    await expect(
      money.toNprSnapshot(executor([row('2026-11-01')]), SCOPE, usd, lateUtc),
    ).rejects.toMatchObject({ response: { code: 'fx_rate_stale' } });
  });

  it('never falls back to an older rate: the newest row decides', async () => {
    const { money } = service();
    await expect(
      money.toNprSnapshot(executor([row('2026-10-01')]), SCOPE, usd, ON),
    ).rejects.toMatchObject({ response: { code: 'fx_rate_stale' } });
  });

  it('does not read the setting or check age for NPR', async () => {
    const { money, asked } = service();
    expect(
      await money.toNprSnapshot(executor([]), SCOPE, { amount: '5.00', currency: 'NPR' }, ON),
    ).toMatchObject({ amountNpr: '5.00', rateDate: '2026-11-09' });
    expect(asked).toEqual([]);
  });

  it('still answers plain 409 conflict when there is no rate at all', async () => {
    const { money } = service();
    await expect(money.toNprSnapshot(executor([]), SCOPE, usd, ON)).rejects.toMatchObject({
      response: { code: 'conflict' },
    });
  });
});
