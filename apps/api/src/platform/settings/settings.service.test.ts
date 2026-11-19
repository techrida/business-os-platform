// Unit tests for SettingsService with a fake transaction (no database).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/settings.service.test.ts
//
// Two things are checked here. (1) The read-modify-write helpers `lock` and `getLocked`: the advisory lock must
// be the first statement after the scope read and BEFORE the locked read, and must use the same lock text as
// `set()`. A fake cannot prove two writers queue up; that needs Postgres (document-settings.integration.test.ts).
// (2) The generic write path refuses a bad `entity.profile` with 400 through the real SETTINGS schema.
import {
  DEFAULT_DOCUMENT_STYLE,
  DEFAULT_TERM_PRESETS,
  EMPTY_COMPANY_PROFILE,
} from '@bos/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { Db, DbTransaction } from '../db/db.module';
import { SettingsService, settingLockKey } from './settings.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '10000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000001';
const dialect = new PgDialect();

/** A transaction that records every statement as rendered SQL plus params and answers from `rows`. */
function fakeTx(
  rows: {
    setting?: { version: number; value: unknown } | null;
    /** The saved version a stale-edit check reads under the lock; null or left out means nothing saved. */
    current?: number | null;
  } = {},
) {
  const statements: { text: string; params: unknown[] }[] = [];
  const tx = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      statements.push({ text, params });
      if (text.includes('current_setting')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: TENANT,
              organization_id: ENTITY,
              actor_kind: 'user',
              actor_id: USER,
            },
          ],
        });
      }
      if (text.includes('INSERT INTO app.settings')) {
        return Promise.resolve({ rows: [{ version: 4 }] });
      }
      if (text.includes('SELECT version FROM app.settings')) {
        return Promise.resolve({ rows: rows.current == null ? [] : [{ version: rows.current }] });
      }
      if (text.includes('SELECT version, value FROM app.settings')) {
        return Promise.resolve({ rows: rows.setting ? [rows.setting] : [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { tx: tx as unknown as DbTransaction, statements };
}

const service = new SettingsService({} as Db);
const lockStatement = (s: { text: string }) => s.text.includes('pg_advisory_xact_lock');

describe('settingLockKey', () => {
  it('names tenant, entity and key, so two keys or two entities never share a lock', () => {
    expect(settingLockKey(TENANT, ENTITY, 'quotation.term_presets')).toBe(
      `${TENANT}:${ENTITY}:quotation.term_presets`,
    );
    expect(settingLockKey(TENANT, ENTITY, 'document.style')).not.toBe(
      settingLockKey(TENANT, ENTITY, 'quotation.term_presets'),
    );
  });
});

describe('SettingsService.getLocked', () => {
  it('takes the advisory lock before it reads, on the transaction it was given', async () => {
    const { tx, statements } = fakeTx({ setting: { version: 3, value: [] } });
    await expect(service.getLocked(tx, 'quotation.term_presets')).resolves.toEqual({
      value: [],
      version: 3,
    });
    const lockAt = statements.findIndex(lockStatement);
    const readAt = statements.findIndex((s) => s.text.includes('SELECT version, value'));
    expect(lockAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(statements[lockAt]?.params).toEqual([
      settingLockKey(TENANT, ENTITY, 'quotation.term_presets'),
    ]);
  });

  it('answers the default with version null when the key was never written', async () => {
    const { tx } = fakeTx({ setting: null });
    const result = await service.getLocked(tx, 'quotation.term_presets');
    expect(result).toEqual({ value: DEFAULT_TERM_PRESETS, version: null });
  });

  it('hands out a copy of the default, so a caller that pushes to it changes nothing for others', async () => {
    const first = await service.getLocked(fakeTx().tx, 'quotation.term_presets');
    first.value.push({
      id: '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f',
      kind: 'scope',
      name: 'x',
      body: 'y',
    });
    const second = await service.getLocked(fakeTx().tx, 'quotation.term_presets');
    expect(second.value).toEqual(DEFAULT_TERM_PRESETS);
    expect(second.value).toHaveLength(first.value.length - 1);
    // The shared default itself was not touched either.
    expect(first.value).not.toBe(DEFAULT_TERM_PRESETS);
    expect(DEFAULT_TERM_PRESETS.some((p) => p.name === 'x')).toBe(false);
  });
});

describe('SettingsService.lock and set', () => {
  it('lock() takes the same lock text that set() takes', async () => {
    const locked = fakeTx();
    await service.lock(locked.tx, 'document.style');
    const written = fakeTx();
    await service.set(written.tx, 'format.number_systems', {
      NPR: 'international',
      INR: 'international',
      USD: 'international',
    });
    const key = (s: typeof locked.statements) => s.find(lockStatement)?.params[0];
    expect(key(locked.statements)).toBe(settingLockKey(TENANT, ENTITY, 'document.style'));
    expect(key(written.statements)).toBe(settingLockKey(TENANT, ENTITY, 'format.number_systems'));
  });

  it('set() still locks before it inserts (backwards compatible)', async () => {
    const { tx, statements } = fakeTx();
    await expect(
      service.set(tx, 'format.number_systems', {
        NPR: 'international',
        INR: 'international',
        USD: 'international',
      }),
    ).resolves.toEqual({
      version: 4,
    });
    const lockAt = statements.findIndex(lockStatement);
    const insertAt = statements.findIndex((s) => s.text.includes('INSERT INTO app.settings'));
    expect(lockAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(lockAt);
  });

  it('a read-modify-write that takes the lock first, then set(), locks twice in one transaction (re-entrant) and inserts once', async () => {
    const { tx, statements } = fakeTx({ setting: { version: 3, value: [] } });
    const { version } = await service.getLocked(tx, 'quotation.term_presets');
    expect(version).toBe(3);
    await service.set(tx, 'quotation.term_presets', []);
    expect(statements.filter(lockStatement)).toHaveLength(2);
    expect(statements.filter((s) => s.text.includes('INSERT INTO app.settings'))).toHaveLength(1);
  });
});

describe('SettingsService.set with entity.profile (the generic PUT /v1/admin/settings/:key path)', () => {
  // The setting holds a logo as bytes only as the legacy value migration 0058 leaves; the same schema guards it.
  const profileWith = (legacyLogoDataUrl: string | null) => ({
    ...EMPTY_COMPANY_PROFILE,
    legacyLogoDataUrl,
  });
  const b64 = (svg: string) => Buffer.from(svg).toString('base64');
  const SCRIPT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  it('accepts a plain PNG data URL', async () => {
    const { tx } = fakeTx();
    await expect(
      service.set(tx, 'entity.profile', profileWith('data:image/png;base64,iVBORw0KGgo=')),
    ).resolves.toEqual({ version: 4 });
  });

  it.each([
    ['an html document', `data:text/html;base64,${b64('<script>alert(1)</script>')}`],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a remote URL', 'https://example.com/logo.png'],
    ['a non-base64 data URL', 'data:image/png,<script>alert(1)</script>'],
  ])('refuses %s as the logo with 400, before any statement runs', async (_label, logo) => {
    const { tx, statements } = fakeTx();
    await expect(service.set(tx, 'entity.profile', profileWith(logo))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(statements).toEqual([]);
  });

  it.each([
    ['document.style', { ...DEFAULT_DOCUMENT_STYLE, layout: 'nope' }],
    ['document.style', { ...DEFAULT_DOCUMENT_STYLE, primaryColour: 'blue' }],
    ['format.number_systems', 'metric'],
    [
      'quotation.term_presets',
      [
        { id: '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f', kind: 'scope', name: 'Same', body: 'a' },
        { id: '5f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f', kind: 'scope', name: 'SAME', body: 'b' },
      ],
    ],
  ] as const)('refuses a bad value for %s with 400', async (key, value) => {
    const { tx, statements } = fakeTx();
    await expect(service.set(tx, key, value)).rejects.toBeInstanceOf(BadRequestException);
    expect(statements).toEqual([]);
  });

  it('accepts a logo document id', async () => {
    const { tx } = fakeTx();
    await expect(
      service.set(tx, 'entity.profile', {
        ...EMPTY_COMPANY_PROFILE,
        logoDocumentId: '0b8f7c1e-3d2a-4f5b-9c6d-7e8f9a0b1c2d',
      }),
    ).resolves.toEqual({ version: 4 });
  });

  it.each([
    [
      'a data URL as the logo document id',
      { logoDocumentId: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
    ['the pre-U12 logoDataUrl field', { logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  ])('refuses %s with 400, before any statement runs', async (_label, over) => {
    const { tx, statements } = fakeTx();
    await expect(
      service.set(tx, 'entity.profile', { ...EMPTY_COMPANY_PROFILE, ...over }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(statements).toEqual([]);
  });

  it('refuses an SVG logo (script risk) with 400', async () => {
    const { tx } = fakeTx();
    await expect(
      service.set(
        tx,
        'entity.profile',
        profileWith(`data:image/svg+xml;base64,${b64(SCRIPT_SVG)}`),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

const insertStatement = (s: { text: string }) => s.text.includes('INSERT INTO app.settings');
const PROFILE_KEY = 'format.number_systems' as const;
const NUMBER_SYSTEMS = {
  NPR: 'international',
  INR: 'international',
  USD: 'international',
} as const;

describe('SettingsService.set with expectedVersion (stale-edit guard)', () => {
  const stale = {
    code: 'stale_setting',
    message: expect.stringContaining('changed by someone else') as unknown,
  };

  it('refuses a stale version with 409 stale_setting and writes nothing', async () => {
    const { tx, statements } = fakeTx({ current: 5 });
    const attempt = service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: 3 });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({ response: stale, status: 409 });
    expect(statements.filter(insertStatement)).toEqual([]);
  });

  it('writes the next version when the version matches, checking after the lock', async () => {
    const { tx, statements } = fakeTx({ current: 3 });
    await expect(
      service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: 3 }),
    ).resolves.toEqual({ version: 4 });
    const lockAt = statements.findIndex(lockStatement);
    const checkAt = statements.findIndex((s) =>
      s.text.includes('SELECT version FROM app.settings'),
    );
    const insertAt = statements.findIndex(insertStatement);
    expect(checkAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(checkAt);
  });

  it('null with no saved row writes (version 1 in the database; the fake answers 4)', async () => {
    const { tx, statements } = fakeTx({ current: null });
    await expect(
      service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: null }),
    ).resolves.toEqual({ version: 4 });
    expect(statements.filter(insertStatement)).toHaveLength(1);
  });

  it('null when a row already exists is 409 and writes nothing', async () => {
    const { tx, statements } = fakeTx({ current: 1 });
    await expect(
      service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: null }),
    ).rejects.toMatchObject({ response: stale, status: 409 });
    expect(statements.filter(insertStatement)).toEqual([]);
  });

  it('a number when nothing is saved is 409 too', async () => {
    const { tx } = fakeTx({ current: null });
    await expect(
      service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('without the field it writes unconditionally and never reads the saved version', async () => {
    const { tx, statements } = fakeTx({ current: 9 });
    await expect(service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS)).resolves.toEqual({ version: 4 });
    expect(statements.some((s) => s.text.includes('SELECT version FROM app.settings'))).toBe(false);
  });

  it('a bad value is still 400 (not 409) and runs no statement, even with a stale version', async () => {
    const { tx, statements } = fakeTx({ current: 5 });
    await expect(
      service.set(tx, PROFILE_KEY, 'metric', { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(statements).toEqual([]);
  });

  it('two writers that loaded the same version: exactly one succeeds, the other gets 409', async () => {
    // A tiny in-memory Postgres: one saved version, and an advisory lock that a transaction holds until
    // it finishes (re-entrant for its owner), so the second writer's check runs only after the first commits.
    let saved: number | null = 3;
    let lockTail: Promise<void> = Promise.resolve();
    const inserts: number[] = [];
    function openTx() {
      let held = false;
      let release: () => void = () => undefined;
      const tx = {
        async execute(query: Parameters<typeof dialect.sqlToQuery>[0]) {
          const { sql: text } = dialect.sqlToQuery(query);
          if (text.includes('current_setting')) {
            return {
              rows: [
                { tenant_id: TENANT, organization_id: ENTITY, actor_kind: 'user', actor_id: USER },
              ],
            };
          }
          if (text.includes('pg_advisory_xact_lock')) {
            if (!held) {
              held = true;
              const previous = lockTail;
              lockTail = new Promise<void>((resolve) => {
                release = resolve;
              });
              await previous;
            }
            return { rows: [] };
          }
          // Yield, so a missing lock would let the other writer's statements interleave here.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (text.includes('SELECT version FROM app.settings')) {
            return { rows: saved === null ? [] : [{ version: saved }] };
          }
          if (text.includes('INSERT INTO app.settings')) {
            saved = (saved ?? 0) + 1;
            inserts.push(saved);
            return { rows: [{ version: saved }] };
          }
          return { rows: [] };
        },
      };
      return { tx: tx as unknown as DbTransaction, commit: () => release() };
    }
    const write = async () => {
      const { tx, commit } = openTx();
      try {
        return await service.set(tx, PROFILE_KEY, NUMBER_SYSTEMS, { expectedVersion: 3 });
      } finally {
        commit();
      }
    };

    const results = await Promise.allSettled([write(), write()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ value: { version: 4 } });
    expect(refused).toHaveLength(1);
    expect((refused[0] as { reason: unknown }).reason).toBeInstanceOf(ConflictException);
    expect(inserts).toEqual([4]);
  });
});
