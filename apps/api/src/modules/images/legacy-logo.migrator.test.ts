// Unit test of LegacyLogoMigrator (U12, migration 0058's app-side half): each entity's legacy data-URL logo is
// uploaded through the scanned receive path (createAndReceiveScanned, never the generated path that skips the scan)
// under the system actor, and the profile's next version points at it with the legacy value cleared and every other
// field kept. A second run finds nothing; an invalid data URL, a profile changed meanwhile and any failure are logged
// and skipped (never the data URL in a log line), and nothing escapes the run or the bootstrap hook.
// Fakes: the cross-tenant scan (derived from the fake settings), SettingsService (versioned, with the stale_setting
// 409), DocumentsService and a database whose transaction only answers withTx.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/legacy-logo.migrator.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import {
  decodeLegacyLogo,
  LEGACY_LOGO_JOB,
  LegacyLogoMigrator,
  type LegacyLogoSettings,
  type LegacyLogoStore,
} from './legacy-logo.migrator';

const TENANT = randomUUID();
const ORG = randomUUID();
const ORG_B = randomUUID();
const scopeA: TxScope = { tenantId: TENANT, organizationId: ORG };
const scopeB: TxScope = { tenantId: TENANT, organizationId: ORG_B };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
const PNG_URL = dataUrl('image/png', PNG);

const profile = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  ...EMPTY_COMPANY_PROFILE,
  displayName: 'Acme Trading',
  email: 'hello@acme.test',
  phones: ['+97715550100'],
  logoDocumentId: null,
  legacyLogoDataUrl: PNG_URL,
  ...over,
});

// ------------------------------------------------------------------------------------------- fakes

const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
const db = { transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;

const keyOf = (s: TxScope) => `${s.tenantId}:${s.organizationId}`;
let saved: Map<string, { scope: TxScope; versions: CompanyProfile[] }>;
let txScopes: TxScope[];

function save(scope: TxScope, value: CompanyProfile): void {
  const entry = saved.get(keyOf(scope)) ?? { scope, versions: [] };
  entry.versions.push(value);
  saved.set(keyOf(scope), entry);
}
const latest = (scope: TxScope) => saved.get(keyOf(scope))?.versions.at(-1);

const settings = {
  getCurrent: vi.fn((scope: TxScope) => {
    const entry = saved.get(keyOf(scope));
    const value = entry?.versions.at(-1);
    return Promise.resolve(
      value === undefined
        ? { value: { ...EMPTY_COMPANY_PROFILE }, version: null }
        : { value: structuredClone(value), version: entry?.versions.length ?? null },
    );
  }),
  set: vi.fn(
    (
      _tx: unknown,
      _key: string,
      value: CompanyProfile,
      options: { expectedVersion?: number | null } = {},
    ) => {
      const scope = txScopes.at(-1);
      if (scope === undefined) throw new Error('set outside withTx');
      const current = saved.get(keyOf(scope))?.versions.length ?? null;
      if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
        return Promise.reject(
          new ConflictException({ code: 'stale_setting', message: 'changed by someone else' }),
        );
      }
      save(scope, value);
      return Promise.resolve({ version: current === null ? 1 : current + 1 });
    },
  ),
};

/** The scan as the SQL defines it: the latest version holds a legacy data URL and no logo document. */
const store: LegacyLogoStore = {
  pending: vi.fn(() =>
    Promise.resolve(
      [...saved.values()]
        .filter(({ versions }) => {
          const v = versions.at(-1);
          return typeof v?.legacyLogoDataUrl === 'string' && v.logoDocumentId === null;
        })
        .map(({ scope }) => scope),
    ),
  ),
};

const documents = {
  createAndReceiveScanned: vi.fn(() =>
    Promise.resolve({ documentId: randomUUID(), versionId: randomUUID() }),
  ),
  // Present only to prove the migrator never takes the path that skips the scan.
  receiveGenerated: vi.fn(),
  createGenerated: vi.fn(),
};

let logs: string[];

function migrator() {
  return new LegacyLogoMigrator(db, documents, settings as unknown as LegacyLogoSettings, store);
}

beforeEach(() => {
  saved = new Map();
  txScopes = [];
  logs = [];
  vi.clearAllMocks();
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
  }
  // Every write runs in withTx under the entity's scope; the scope is known from the receive call before it.
  documents.createAndReceiveScanned.mockImplementation(((
    _owner: unknown,
    _file: unknown,
    who: { scope: TxScope },
  ) => {
    txScopes.push(who.scope);
    return Promise.resolve({ documentId: randomUUID(), versionId: randomUUID() });
  }) as never);
});

afterEach(() => vi.restoreAllMocks());

const noDataUrlLogged = () => {
  for (const line of logs) expect(line).not.toContain('base64');
};

// ------------------------------------------------------------------------------------------- tests

describe('LegacyLogoMigrator', () => {
  it('uploads the legacy logo through the scanned path as the system actor and points the profile at it', async () => {
    save(scopeA, profile());

    await expect(migrator().run()).resolves.toEqual({ migrated: 1, skipped: 0, failed: 0 });

    expect(documents.createAndReceiveScanned).toHaveBeenCalledTimes(1);
    expect(documents.createAndReceiveScanned).toHaveBeenCalledWith(
      { ownerType: 'entity_logo', ownerId: ORG },
      { filename: 'logo.png', declaredMime: 'image/png', bytes: PNG },
      {
        scope: scopeA,
        actor: expect.objectContaining({
          kind: 'system',
          id: `system:${LEGACY_LOGO_JOB}`,
        }) as unknown,
      },
    );
    expect(documents.receiveGenerated).not.toHaveBeenCalled();
    expect(documents.createGenerated).not.toHaveBeenCalled();

    const created = (await documents.createAndReceiveScanned.mock.results[0]?.value) as {
      documentId: string;
    };
    expect(settings.set).toHaveBeenCalledWith(tx, 'entity.profile', expect.anything(), {
      expectedVersion: 1,
    });
    expect(latest(scopeA)).toEqual(
      profile({ logoDocumentId: created.documentId, legacyLogoDataUrl: null }),
    );
    expect(saved.get(keyOf(scopeA))?.versions).toHaveLength(2);
    noDataUrlLogged();
  });

  it('migrates JPEG and WebP logos with their own file name and type', async () => {
    save(scopeA, profile({ legacyLogoDataUrl: dataUrl('image/jpeg', JPEG) }));
    save(scopeB, profile({ legacyLogoDataUrl: dataUrl('image/webp', WEBP) }));

    await expect(migrator().run()).resolves.toEqual({ migrated: 2, skipped: 0, failed: 0 });
    expect(documents.createAndReceiveScanned).toHaveBeenCalledWith(
      expect.anything(),
      { filename: 'logo.jpg', declaredMime: 'image/jpeg', bytes: JPEG },
      expect.anything(),
    );
    expect(documents.createAndReceiveScanned).toHaveBeenCalledWith(
      expect.anything(),
      { filename: 'logo.webp', declaredMime: 'image/webp', bytes: WEBP },
      expect.anything(),
    );
  });

  it('is idempotent: a second run finds nothing and writes nothing', async () => {
    save(scopeA, profile());
    const job = migrator();
    await job.run();
    const after = saved.get(keyOf(scopeA))?.versions.length;

    await expect(job.run()).resolves.toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(documents.createAndReceiveScanned).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(saved.get(keyOf(scopeA))?.versions.length).toBe(after);
  });

  it('skips a profile that was migrated between the scan and its read', async () => {
    save(scopeA, profile());
    vi.mocked(store.pending).mockResolvedValueOnce([scopeA]);
    save(scopeA, profile({ logoDocumentId: randomUUID(), legacyLogoDataUrl: null }));

    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(documents.createAndReceiveScanned).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it.each([
    ['an SVG', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`],
    ['broken base64', 'data:image/png;base64,iVBORw0KGgo*'],
    ['bytes of another type (a JPEG labelled PNG)', dataUrl('image/png', JPEG)],
    [
      'a body over the image cap',
      dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(524_288)])),
    ],
  ])('skips %s with a log line, uploading and writing nothing', async (_name, url) => {
    save(scopeA, profile({ legacyLogoDataUrl: url }));

    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(documents.createAndReceiveScanned).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes(`entity=${ORG}`) && l.includes('legacy logo skipped'))).toBe(
      true,
    );
    noDataUrlLogged();
  });

  it('skips a stored profile the setting schema would refuse, before any document is created', async () => {
    save(scopeA, { ...profile(), unexpected: true } as unknown as CompanyProfile);

    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(documents.createAndReceiveScanned).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
    expect(
      logs.some((l) => l.includes(`entity=${ORG}`) && l.includes('kind=profile_invalid')),
    ).toBe(true);
  });

  it('skips with a log when the profile changed between its read and the write (stale version)', async () => {
    save(scopeA, profile());
    documents.createAndReceiveScanned.mockImplementationOnce(((
      _owner: unknown,
      _file: unknown,
      who: { scope: TxScope },
    ) => {
      txScopes.push(who.scope);
      // An admin saves the profile while the upload runs.
      save(scopeA, profile({ displayName: 'Acme Renamed' }));
      return Promise.resolve({ documentId: randomUUID(), versionId: randomUUID() });
    }) as never);

    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(latest(scopeA)).toEqual(profile({ displayName: 'Acme Renamed' }));
    expect(logs.some((l) => l.includes('changed meanwhile') && l.includes(`entity=${ORG}`))).toBe(
      true,
    );
    noDataUrlLogged();
  });

  it('logs and goes on when one entity fails; a failed receive writes no profile', async () => {
    save(scopeA, profile());
    save(scopeB, profile());
    documents.createAndReceiveScanned.mockImplementationOnce(() =>
      Promise.reject(new Error('queue down')),
    );

    await expect(migrator().run()).resolves.toEqual({ migrated: 1, skipped: 0, failed: 1 });
    expect(latest(scopeA)?.legacyLogoDataUrl).toBe(PNG_URL);
    expect(latest(scopeB)?.logoDocumentId).not.toBeNull();
    expect(logs.some((l) => l.includes(`entity=${ORG}`) && l.includes('kind=Error'))).toBe(true);
    expect(logs.join('\n')).not.toContain('queue down');
    noDataUrlLogged();
  });

  it('does not throw when the database fails: neither the scan, a read, nor the bootstrap hook', async () => {
    vi.mocked(store.pending).mockRejectedValueOnce(new Error('connection refused'));
    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 0, failed: 0 });

    save(scopeA, profile());
    settings.getCurrent.mockRejectedValueOnce(new Error('connection reset'));
    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 0, failed: 1 });

    vi.mocked(store.pending).mockRejectedValueOnce(new Error('connection refused'));
    const job = migrator();
    expect(() => job.onApplicationBootstrap()).not.toThrow();
    await vi.waitFor(() => expect(logs.some((l) => l.includes('could not list'))).toBe(true));
  });

  it('runs each entity once per run: a failure is not retried in a loop', async () => {
    save(scopeA, profile());
    documents.createAndReceiveScanned.mockImplementation(() => Promise.reject(new Error('down')));

    await expect(migrator().run()).resolves.toEqual({ migrated: 0, skipped: 0, failed: 1 });
    expect(documents.createAndReceiveScanned).toHaveBeenCalledTimes(1);
  });
});

describe('decodeLegacyLogo', () => {
  it('decodes a PNG data URL into the receive file', () => {
    expect(decodeLegacyLogo(PNG_URL)).toEqual({
      file: { filename: 'logo.png', declaredMime: 'image/png', bytes: PNG },
    });
  });

  it.each([
    ['https://example.test/logo.png', 'not_data_url'],
    ['data:image/gif;base64,R0lGODlh', 'not_data_url'],
    ['data:image/png;base64,', 'not_data_url'],
    ['data:image/png;base64,AAA', 'not_data_url'],
    [dataUrl('image/webp', PNG), 'wrong_type'],
  ])('refuses %s as %s', (url, kind) => {
    expect(decodeLegacyLogo(url)).toEqual({ invalid: kind });
  });
});
