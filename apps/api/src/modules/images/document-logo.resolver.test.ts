// Unit test of DocumentLogoResolverFactory (U12, "Snapshots freeze BYTES"): the newest clean version of a live
// entity_logo in the scope's tenant and entity becomes a data URL; anything else is null; an oversize file is null
// with a warning; a storage failure throws (so the issuer raises DocumentLogoUnavailableError). Fakes: the lookup
// (the database read) and the storage adapter.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/document-logo.resolver.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StoredFileNotFoundError } from '../../platform/documents/storage.adapter';
import {
  DocumentLogoUnavailableError,
  buildDocumentStyleSnapshot,
} from '../quotations/render/issuer';
import {
  DocumentLogoResolverFactory,
  MAX_LOGO_DATA_URL_CHARS,
  type LogoDocumentRow,
  type LogoStorage,
} from './document-logo.resolver';

const TENANT = randomUUID();
const ORG = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };
const DOC = randomUUID();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const version = (over: Partial<LogoDocumentRow['versions'][number]> = {}) => ({
  version: 1,
  status: 'clean',
  detectedMime: 'image/png',
  sizeBytes: PNG.length,
  storageKey: `${TENANT}/v1`,
  ...over,
});

const row = (over: Partial<LogoDocumentRow> = {}): LogoDocumentRow => ({
  tenantId: TENANT,
  organizationId: ORG,
  ownerType: 'entity_logo',
  removedAt: null,
  versions: [version()],
  ...over,
});

function setup(found: LogoDocumentRow | undefined, files: Record<string, Buffer | Error> = {}) {
  const lookup = vi.fn(() => Promise.resolve(found));
  const storage: LogoStorage = {
    openClean: vi.fn((key: string) => {
      const file = files[key] ?? PNG;
      if (file instanceof Error) return Promise.reject(file);
      return Promise.resolve(Readable.from([file]));
    }),
  };
  const factory = new DocumentLogoResolverFactory(lookup, storage);
  return { resolve: factory.forScope(scope), lookup, storage };
}

afterEach(() => vi.restoreAllMocks());

describe('DocumentLogoResolverFactory', () => {
  it('turns the clean entity logo into a data URL of its detected type, read in the given scope', async () => {
    const { resolve, lookup, storage } = setup(
      row({ versions: [version({ detectedMime: 'image/jpeg' })] }),
    );
    await expect(resolve(DOC)).resolves.toBe(`data:image/jpeg;base64,${PNG.toString('base64')}`);
    expect(lookup).toHaveBeenCalledWith(scope, DOC);
    expect(storage.openClean).toHaveBeenCalledWith(`${TENANT}/v1`);
  });

  it('uses the newest clean version, not a newer one still quarantined or rejected', async () => {
    const newer = Buffer.from([0xff, 0xd8, 0xff, 9]);
    const { resolve, storage } = setup(
      row({
        versions: [
          version({ version: 1, storageKey: `${TENANT}/v1` }),
          version({ version: 2, storageKey: `${TENANT}/v2` }),
          version({ version: 3, status: 'quarantined', storageKey: `${TENANT}/v3` }),
          version({ version: 4, status: 'rejected', storageKey: `${TENANT}/v4` }),
        ],
      }),
      { [`${TENANT}/v2`]: newer },
    );
    await expect(resolve(DOC)).resolves.toBe(`data:image/png;base64,${newer.toString('base64')}`);
    expect(storage.openClean).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown document', undefined],
    ['a removed document', row({ removedAt: new Date() })],
    ['another owner type (a customer logo)', row({ ownerType: 'customer_logo' })],
    ['a profile picture', row({ ownerType: 'user_avatar' })],
    ['another entity', row({ organizationId: randomUUID() })],
    ['another tenant', row({ tenantId: randomUUID() })],
    ['a version not scanned clean yet', row({ versions: [version({ status: 'quarantined' })] })],
    ['a rejected version', row({ versions: [version({ status: 'rejected' })] })],
    ['no versions', row({ versions: [] })],
    ['an undetected type', row({ versions: [version({ detectedMime: null })] })],
    [
      'a type that is not an image',
      row({ versions: [version({ detectedMime: 'application/pdf' })] }),
    ],
  ])('answers null, without opening storage, for %s', async (_name, found) => {
    const { resolve, storage } = setup(found);
    await expect(resolve(DOC)).resolves.toBeNull();
    expect(storage.openClean).not.toHaveBeenCalled();
  });

  it('answers null with a warning when the recorded size is over the snapshot cap, without reading', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolve, storage } = setup(row({ versions: [version({ sizeBytes: 600 * 1024 })] }));
    await expect(resolve(DOC)).resolves.toBeNull();
    expect(storage.openClean).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kind=oversize'));
  });

  it('answers null with a warning when the bytes are over the cap although the size column is small', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const big = Buffer.alloc(Math.ceil((MAX_LOGO_DATA_URL_CHARS * 3) / 4) + 10, 1);
    const { resolve } = setup(row(), { [`${TENANT}/v1`]: big });
    await expect(resolve(DOC)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kind=oversize'));
  });

  it('accepts a 512 KiB logo (the upload cap) inside the snapshot cap', async () => {
    const kib512 = Buffer.alloc(512 * 1024, 7);
    const { resolve } = setup(row({ versions: [version({ sizeBytes: kib512.length })] }), {
      [`${TENANT}/v1`]: kib512,
    });
    const url = await resolve(DOC);
    expect(url?.length).toBeLessThanOrEqual(MAX_LOGO_DATA_URL_CHARS);
    expect(url?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it.each([
    ['a clean file missing from storage', new StoredFileNotFoundError()],
    ['a storage failure', Object.assign(new Error('EIO'), { code: 'EIO' })],
  ])('throws on %s, so a referenced logo is never silently dropped', async (_name, failure) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolve } = setup(row(), { [`${TENANT}/v1`]: failure });
    await expect(resolve(DOC)).rejects.toBe(failure);
  });

  it('throws when the stream fails midway', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const storage: LogoStorage = {
      openClean: () =>
        Promise.resolve(
          new Readable({
            read() {
              this.destroy(new Error('read failed'));
            },
          }),
        ),
    };
    const factory = new DocumentLogoResolverFactory(() => Promise.resolve(row()), storage);
    await expect(factory.forScope(scope)(DOC)).rejects.toThrow('read failed');
  });

  it('makes the snapshot fail with DocumentLogoUnavailableError on a storage failure (through the issuer)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolve } = setup(row(), { [`${TENANT}/v1`]: new StoredFileNotFoundError() });
    const settings = {
      get: (_s: unknown, key: string) =>
        Promise.resolve(
          key === 'entity.profile'
            ? {
                displayName: null,
                logoDocumentId: DOC,
                phones: [],
                email: null,
                website: null,
                panVatNo: null,
                signatoryName: null,
                signatoryTitle: null,
              }
            : undefined,
        ),
    };
    const error = await buildDocumentStyleSnapshot(
      settings as never,
      scope,
      new Date(),
      resolve,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentLogoUnavailableError);
  });
});
