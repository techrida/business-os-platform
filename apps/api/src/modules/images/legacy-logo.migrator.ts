// Legacy logo migrator (U12, D33; API only: ImagesModule is imported by AppModule, never by the worker). Migration
// 0058 moved each entity's pre-documents data-URL logo to `entity.profile`.legacyLogoDataUrl; once, when the API
// boots, this job uploads each such logo as an `entity_logo` document and points the profile at it:
//   1. the scan (plain pool, across tenants, ids only) finds every entity whose LATEST `entity.profile` version holds
//      a legacy data URL and no `logoDocumentId`;
//   2. per entity, the profile is read again with its version; the data URL must be a PNG, JPEG or WebP whose bytes
//      start with that type's signature and fit the image cap, or the entity is skipped (logged; a doomed upload
//      would leave a refused document behind on every boot);
//   3. DocumentsService.createAndReceiveScanned stores the bytes through the ordinary receive path under the system
//      actor `system:legacy-logo-migrator` (type check, sha256, virus scan queued: these bytes came from a user once,
//      so the scan is never skipped);
//   4. the next profile version is written through SettingsService (versioned and audited by the settings trigger)
//      with `logoDocumentId` = the new document and `legacyLogoDataUrl` = null, every other field unchanged, guarded by
//      the version read in step 2: a profile saved in between makes the write a 409 and the entity is skipped.
//
// Idempotent: a migrated profile has no legacy data URL, so a second boot finds nothing. Each entity is tried once per
// boot (no retry loop); a failure is logged with the entity id and a fixed word (the error name or HTTP status), never
// the data URL, and the rest go on. Nothing escapes the bootstrap hook, and boot never waits for the run.
//
// Left behind: if the receive fails, createAndReceiveScanned throws without the new document's ids, and if the profile
// write fails after it, DocumentsService.remove refuses a system actor (it checks the request principal's grant). The
// document then stays live but unreferenced (nothing serves or prints it); the log names it when the id is known.
import { IMAGE_MAX_BYTES, type CompanyProfile, type ImageOwnerType } from '@bos/contracts';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';

/** The job name after the `system:` prefix of the actor id; the audit log shows `system:legacy-logo-migrator`. */
export const LEGACY_LOGO_JOB = 'legacy-logo-migrator';
const ENTITY_LOGO: ImageOwnerType = 'entity_logo';

/** The cross-tenant scan, as a port: the tests fake it, the drizzle store below reads app.settings. */
export interface LegacyLogoStore {
  /** Every entity whose latest `entity.profile` holds a legacy data URL and no logo document. Ids only. */
  pending(): Promise<TxScope[]>;
}

export const LEGACY_LOGO_STORE = Symbol('LEGACY_LOGO_STORE');

export type LegacyLogoDocuments = Pick<DocumentsService, 'createAndReceiveScanned'>;
export type LegacyLogoSettings = Pick<SettingsService, 'getCurrent' | 'set'>;

export interface LegacyLogoResult {
  migrated: number;
  /** Already migrated by the time it was read again, an invalid data URL, or the profile changed concurrently. */
  skipped: number;
  failed: number;
}

/** A legacy logo decoded and checked: the file the receive path gets. */
export interface LegacyLogoFile {
  filename: string;
  declaredMime: string;
  bytes: Buffer;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether the bytes start with the signature of `mime`: the receive path's type check would refuse anything else. */
function hasSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

/**
 * The legacy data URL as a file, or a fixed word saying why not: `not_data_url` (not a PNG, JPEG or WebP base64 data
 * URL), `too_large` (over IMAGE_MAX_BYTES) or `wrong_type` (the bytes are not of the declared type).
 */
export function decodeLegacyLogo(
  dataUrl: string,
): { file: LegacyLogoFile } | { invalid: 'not_data_url' | 'too_large' | 'wrong_type' } {
  const match = DATA_URL.exec(dataUrl);
  const mime = match?.[1];
  const base64 = match?.[2];
  if (mime === undefined || base64 === undefined || base64.length % 4 !== 0) {
    return { invalid: 'not_data_url' };
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > IMAGE_MAX_BYTES) return { invalid: 'too_large' };
  if (!hasSignature(mime, bytes)) return { invalid: 'wrong_type' };
  return { file: { filename: `logo.${EXTENSION[mime] ?? 'img'}`, declaredMime: mime, bytes } };
}

/** A fixed word for the log: the HTTP status or the error name, never a message (it could carry the value). */
function reasonOf(error: unknown): string {
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  return error instanceof Error ? error.name : 'error';
}

function isStaleSetting(error: unknown): boolean {
  if (!(error instanceof ConflictException)) return false;
  const body = error.getResponse();
  return typeof body === 'object' && (body as { code?: unknown }).code === 'stale_setting';
}

@Injectable()
export class LegacyLogoMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(LegacyLogoMigrator.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DocumentsService) private readonly documents: LegacyLogoDocuments,
    @Inject(SettingsService) private readonly settings: LegacyLogoSettings,
    @Inject(LEGACY_LOGO_STORE) private readonly store: LegacyLogoStore,
  ) {}

  /** Starts the run and returns at once: boot never waits for it, and a failed run never crashes the API. */
  onApplicationBootstrap(): void {
    void this.run().catch((error: unknown) => {
      this.logger.error(`legacy logo migration failed: kind=${reasonOf(error)}`);
    });
  }

  /** One pass over every entity with a legacy logo. Never throws: the scan failing is logged as the run's failure. */
  async run(): Promise<LegacyLogoResult> {
    const result: LegacyLogoResult = { migrated: 0, skipped: 0, failed: 0 };
    let entities: TxScope[];
    try {
      entities = await this.store.pending();
    } catch (error) {
      this.logger.error(`legacy logo migration could not list entities: kind=${reasonOf(error)}`);
      return result;
    }
    for (const scope of entities) {
      try {
        result[await this.migrate(scope)] += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `legacy logo not migrated: entity=${scope.organizationId} kind=${reasonOf(error)}`,
        );
      }
    }
    if (entities.length > 0) {
      this.logger.log(
        `legacy logo migration done: migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}`,
      );
    }
    return result;
  }

  private async migrate(scope: TxScope): Promise<'migrated' | 'skipped'> {
    const entity = scope.organizationId;
    const { value, version } = await this.settings.getCurrent(scope, 'entity.profile');
    const legacy: unknown = value.legacyLogoDataUrl;
    if (version === null || typeof legacy !== 'string' || (value.logoDocumentId ?? null) !== null) {
      return 'skipped'; // Migrated (or replaced) since the scan.
    }
    const decoded = decodeLegacyLogo(legacy);
    if ('invalid' in decoded) {
      this.logger.warn(`legacy logo skipped: entity=${entity} kind=${decoded.invalid}`);
      return 'skipped';
    }

    const who = { scope, actor: systemActor(LEGACY_LOGO_JOB) };
    // The owner id is the entity: the entity_logo policy lets the system actor add only the scope's own logo.
    const { documentId } = await this.documents.createAndReceiveScanned(
      { ownerType: ENTITY_LOGO, ownerId: entity },
      decoded.file,
      who,
    );
    const next: CompanyProfile = { ...value, logoDocumentId: documentId, legacyLogoDataUrl: null };
    try {
      await withTx(this.db, scope, who.actor, (tx) =>
        this.settings.set(tx, 'entity.profile', next, { expectedVersion: version }),
      );
    } catch (error) {
      if (isStaleSetting(error)) {
        this.logger.warn(
          `legacy logo skipped, the profile changed meanwhile: entity=${entity} document=${documentId} left unreferenced`,
        );
        return 'skipped';
      }
      this.logger.error(
        `legacy logo profile write failed: entity=${entity} document=${documentId} left unreferenced kind=${reasonOf(error)}`,
      );
      throw error;
    }
    this.logger.log(`legacy logo migrated: entity=${entity} document=${documentId}`);
    return 'migrated';
  }
}

/**
 * The scan on the real table, on the plain pool like the other boot jobs: it crosses tenants on purpose (no request,
 * no tenant) and writes nothing. The latest version per entity is picked first, then filtered, so a logo a later
 * version cleared is never brought back. Ids only: no data URL is held in bulk.
 */
export function drizzleLegacyLogoStore(db: Db): LegacyLogoStore {
  return {
    async pending() {
      const result = await db.execute<{ tenant_id: string; organization_id: string }>(sql`
        SELECT latest.tenant_id, latest.organization_id
          FROM (
            SELECT DISTINCT ON (tenant_id, organization_id) tenant_id, organization_id, value
              FROM app.settings
             WHERE key = 'entity.profile'
             ORDER BY tenant_id, organization_id, version DESC
          ) latest
         WHERE jsonb_typeof(latest.value) = 'object'
           AND jsonb_typeof(latest.value -> 'legacyLogoDataUrl') = 'string'
           AND coalesce(jsonb_typeof(latest.value -> 'logoDocumentId'), 'null') = 'null'
         ORDER BY latest.tenant_id, latest.organization_id`);
      return result.rows.map((r) => ({ tenantId: r.tenant_id, organizationId: r.organization_id }));
    },
  };
}
