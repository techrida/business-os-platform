// Unit tests for CurrencyEnabledService (D44) with a fake database (no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/currency-enabled.test.ts
//
// The real SettingsService reads `currency.enabled` from the fake: a saved row when the test gives one, otherwise
// no rows, so the default list comes from the real contract SETTING_DEFAULTS, not from a value typed in here.
import { UnprocessableEntityException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { CurrencyEnabledService } from './currency-enabled';
import { SettingsService } from './settings.service';

const scope: TxScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
};
const dialect = new PgDialect();

/** A Db whose settings read answers `saved` (null: nothing saved) and that counts the reads. */
function serviceWith(saved: unknown[] | null) {
  const reads: unknown[][] = [];
  const db = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (!text.includes('FROM app.settings')) throw new Error(`unexpected query: ${text}`);
      reads.push(params);
      return Promise.resolve({ rows: saved ? [{ version: 2, value: saved }] : [] });
    },
  } as unknown as Db;
  return { service: new CurrencyEnabledService(new SettingsService(db)), reads };
}

/** Runs `fn` and returns what it threw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('CurrencyEnabledService.assertEnabled', () => {
  it('accepts a currency in the saved list', async () => {
    const { service, reads } = serviceWith(['NPR', 'USD']);
    await expect(service.assertEnabled(scope, 'USD')).resolves.toBeUndefined();
    expect(reads).toEqual([[scope.tenantId, scope.organizationId, 'currency.enabled']]);
  });

  it('refuses a currency the company switched off with 422 CURRENCY_NOT_ENABLED', async () => {
    const { service } = serviceWith(['NPR', 'USD']);
    const error = await caught(() => service.assertEnabled(scope, 'INR'));
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
  });

  it('refuses a currency outside every list with the exact message', async () => {
    const { service } = serviceWith(null);
    const error = await caught(() => service.assertEnabled(scope, 'EUR'));
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency EUR is not enabled for this company',
    });
  });

  it('uses the contract default list (NPR, INR, USD) when nothing is saved', async () => {
    const { service, reads } = serviceWith(null);
    await expect(service.assertEnabled(scope, 'INR')).resolves.toBeUndefined();
    await expect(service.assertEnabled(scope, 'USD')).resolves.toBeUndefined();
    expect(reads).toHaveLength(2);
  });

  it('always accepts NPR, even if a saved list left it out, without reading the setting', async () => {
    const { service, reads } = serviceWith(['USD']);
    await expect(service.assertEnabled(scope, 'NPR')).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it('accepts a missing currency (optional on leads and opportunities)', async () => {
    const { service, reads } = serviceWith(['NPR']);
    await expect(service.assertEnabled(scope, null)).resolves.toBeUndefined();
    await expect(service.assertEnabled(scope, undefined)).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });
});

describe('CurrencyEnabledService.assertAllEnabled', () => {
  it('reads the setting once and accepts a mix of enabled, NPR and missing currencies', async () => {
    const { service, reads } = serviceWith(['NPR', 'INR']);
    await expect(
      service.assertAllEnabled(scope, ['INR', 'NPR', null, undefined, 'INR']),
    ).resolves.toBeUndefined();
    expect(reads).toHaveLength(1);
  });

  it('names the first refused currency', async () => {
    const { service } = serviceWith(['NPR', 'INR']);
    const error = await caught(() => service.assertAllEnabled(scope, ['INR', 'USD', 'EUR']));
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency USD is not enabled for this company',
    });
  });

  it('accepts an empty list without reading the setting', async () => {
    const { service, reads } = serviceWith(['NPR']);
    await expect(service.assertAllEnabled(scope, [])).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });
});
