// The entity logo as bytes, for a document snapshot to freeze (U12, "Snapshots freeze BYTES"). The `entity.profile`
// setting references the logo by document id; a quotation (and later an invoice or a purchase order) freezes the
// logo itself as a data URL, so changing or removing the logo afterwards never alters a document already sent.
//
// DocumentLogoResolverFactory.forScope(scope) returns the DocumentLogoResolver that buildDocumentStyleSnapshot takes.
// It answers:
// - the data URL of the newest clean version of the logo document, when the document is a live `entity_logo` of
//   the scope's tenant AND entity, and the version's detected type is PNG, JPEG or WebP;
// - null when there is no such document or usable version (unknown, foreign, removed, wrong owner type, refused:
//   rejected, infected or scan_failed for any other reason, not an image) or the bytes are over the snapshot cap (logged): the snapshot
//   then uses the legacy logo, if any;
// - DocumentLogoPendingError when the document is a live `entity_logo` of the scope with no clean version yet and
//   its newest version is still awaiting its bytes, quarantined (awaiting the scan) or scan_failed only because the
//   scanner was unreachable (SCAN_FAILED_INFRA: the scan sweeper re-queues it): freezing then would print a
//   logo-less document for good, so the caller treats it as unavailable and the render retries once it is clean.
//   A clean older version wins over a newer pending one;
// - a throw when the storage read fails, a missing clean file included: the issuer turns it into
//   DocumentLogoUnavailableError and the render retries, instead of freezing a document without its logo.
//
// DocumentLogoModule provides the factory with its own disk adapter on FILES_ROOT (CoreConfig), so the API and the
// worker can both import it: DocumentsModule (API only) does not export its storage adapter, and the worker has no
// AppConfig. The adapter is stateless, so a second instance on the same root is harmless.
import { IMAGE_MIME, LogoDataUrlSchema } from '@bos/contracts';
import { documents, documentVersions } from '@bos/db';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { CoreConfig } from '../../platform/config/config';
import { DB, type Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { SCAN_FAILED_INFRA } from '../../platform/documents/scan.processor';
import {
  DiskStorageAdapter,
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../platform/documents/storage.adapter';
import type { DocumentLogoResolver } from '../quotations/render/issuer';

const ENTITY_LOGO = 'entity_logo';
/** The longest logo data URL a snapshot accepts (LogoDataUrlSchema). */
export const MAX_LOGO_DATA_URL_CHARS = 720_000;
const DATA_URL_PREFIX_CHARS = 'data:image/jpeg;base64,'.length;

/** A logo document and its versions, as the lookup read them. Every rule is checked again in code. */
export interface LogoDocumentRow {
  tenantId: string;
  organizationId: string;
  ownerType: string;
  removedAt: Date | null;
  versions: {
    version: number;
    status: string;
    detectedMime: string | null;
    sizeBytes: number;
    storageKey: string;
    /** The engine that scanned the version; SCAN_FAILED_INFRA on a scan_failed version the sweeper retries. */
    scanEngine: string | null;
  }[];
}

/** Reads one document and its versions in the scope's tenant and entity; undefined when there is none. */
export type LogoDocumentLookup = (
  scope: TxScope,
  documentId: string,
) => Promise<LogoDocumentRow | undefined>;

/** The lookup on the real tables. A plain read, not a transaction: it writes nothing. */
export function drizzleLogoDocumentLookup(db: Db): LogoDocumentLookup {
  return async (scope, documentId) => {
    const rows = await db
      .select({
        tenantId: documents.tenantId,
        organizationId: documents.organizationId,
        ownerType: documents.ownerType,
        removedAt: documents.removedAt,
        version: documentVersions.version,
        status: documentVersions.status,
        detectedMime: documentVersions.detectedMime,
        sizeBytes: documentVersions.sizeBytes,
        storageKey: documentVersions.storageKey,
        scanEngine: documentVersions.scanEngine,
      })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
      .where(
        and(
          eq(documents.tenantId, scope.tenantId),
          eq(documents.organizationId, scope.organizationId),
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.organizationId, scope.organizationId),
          eq(documents.id, documentId),
        ),
      );
    const [first] = rows;
    if (first === undefined) return undefined;
    return {
      tenantId: first.tenantId,
      organizationId: first.organizationId,
      ownerType: first.ownerType,
      removedAt: first.removedAt,
      versions: rows.map(
        ({ version, status, detectedMime, sizeBytes, storageKey, scanEngine }) => ({
          version,
          status,
          detectedMime,
          sizeBytes,
          storageKey,
          scanEngine,
        }),
      ),
    };
  };
}

/** The base64 length of `bytes` bytes, plus the longest prefix: what the data URL would measure. */
function dataUrlChars(bytes: number): number {
  return DATA_URL_PREFIX_CHARS + 4 * Math.ceil(bytes / 3);
}

/** Version states that may still become clean: the bytes are not in yet, or the virus scan has not finished. */
const PENDING_STATUSES: ReadonlySet<string> = new Set(['awaiting_content', 'quarantined']);

/**
 * The version may still become clean: a pending status, or a scan that failed only because the scanner was
 * unreachable (the scan sweeper puts it back to quarantined). Any other scan_failed is final.
 */
function mayBecomeClean(v: Pick<LogoDocumentRow['versions'][number], 'status' | 'scanEngine'>) {
  return (
    PENDING_STATUSES.has(v.status) ||
    (v.status === 'scan_failed' && v.scanEngine === SCAN_FAILED_INFRA)
  );
}

/**
 * The profile's logo document has no clean version yet but may get one (its newest version awaits its bytes or the
 * scan, or its scan failed on the scanner being unreachable and the sweeper will retry it). Retryable: every caller handles it like any resolver throw, as DocumentLogoUnavailableError, so the render
 * runs again later instead of freezing a document without its logo.
 */
export class DocumentLogoPendingError extends Error {
  readonly kind = 'document_logo_pending';

  constructor() {
    super('The company logo has not been scanned yet');
    this.name = 'DocumentLogoPendingError';
  }
}

/** The most bytes whose data URL still fits the cap. */
const MAX_LOGO_BYTES = Math.floor((MAX_LOGO_DATA_URL_CHARS - DATA_URL_PREFIX_CHARS) / 4) * 3;

export type LogoStorage = Pick<StorageAdapter, 'openClean'>;

/** Injection token of the LogoDocumentLookup the factory reads through. */
export const LOGO_DOCUMENT_LOOKUP = Symbol('LOGO_DOCUMENT_LOOKUP');

@Injectable()
export class DocumentLogoResolverFactory {
  private readonly logger = new Logger(DocumentLogoResolverFactory.name);

  constructor(
    @Inject(LOGO_DOCUMENT_LOOKUP) private readonly lookup: LogoDocumentLookup,
    @Inject(STORAGE_ADAPTER) private readonly storage: LogoStorage,
  ) {}

  /** The resolver for one tenant and entity: the scope the snapshot is built for. */
  forScope(scope: TxScope): DocumentLogoResolver {
    return (documentId) => this.resolve(scope, documentId);
  }

  private async resolve(scope: TxScope, documentId: string): Promise<string | null> {
    const row = await this.lookup(scope, documentId);
    // The query already scopes; the same rules again here, so a query change cannot widen what is frozen.
    if (
      row === undefined ||
      row.removedAt !== null ||
      row.tenantId !== scope.tenantId ||
      row.organizationId !== scope.organizationId ||
      row.ownerType !== ENTITY_LOGO
    ) {
      return null;
    }
    const clean = row.versions.reduce<LogoDocumentRow['versions'][number] | undefined>(
      (newest, v) =>
        v.status === 'clean' && (newest === undefined || v.version > newest.version) ? v : newest,
      undefined,
    );
    if (clean === undefined) {
      const newest = row.versions.reduce<LogoDocumentRow['versions'][number] | undefined>(
        (top, v) => (top === undefined || v.version > top.version ? v : top),
        undefined,
      );
      if (newest !== undefined && mayBecomeClean(newest)) {
        this.logger.warn(`document logo not scanned yet: document=${documentId} kind=pending`);
        throw new DocumentLogoPendingError();
      }
      return null;
    }
    if (
      clean.detectedMime === null ||
      !(IMAGE_MIME as readonly string[]).includes(clean.detectedMime)
    ) {
      return null;
    }
    if (dataUrlChars(clean.sizeBytes) > MAX_LOGO_DATA_URL_CHARS) {
      this.logger.warn(`document logo over the snapshot cap: document=${documentId} kind=oversize`);
      return null;
    }

    let bytes: Buffer | null;
    try {
      bytes = await this.readCapped(clean.storageKey);
    } catch (error) {
      // Fixed words only: the issuer drops the cause, so this line is where an operator finds the kind.
      const kind = error instanceof Error ? error.name : 'error';
      this.logger.warn(`document logo could not be read: document=${documentId} kind=${kind}`);
      throw error;
    }
    if (bytes === null) {
      this.logger.warn(`document logo over the snapshot cap: document=${documentId} kind=oversize`);
      return null;
    }
    const dataUrl = LogoDataUrlSchema.safeParse(
      `data:${clean.detectedMime};base64,${bytes.toString('base64')}`,
    );
    if (!dataUrl.success) {
      this.logger.warn(
        `document logo is not a valid data URL: document=${documentId} kind=invalid`,
      );
      return null;
    }
    return dataUrl.data;
  }

  /** The clean file's bytes, or null once they pass the cap (the size column is not trusted). */
  private async readCapped(storageKey: string): Promise<Buffer | null> {
    const stream = await this.storage.openClean(storageKey);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        if (total > MAX_LOGO_BYTES) return null;
        chunks.push(buffer);
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(chunks);
  }
}

/**
 * Import this module to freeze the entity logo into a snapshot: inject DocumentLogoResolverFactory and pass
 * `factory.forScope(scope)` to buildDocumentStyleSnapshot (or to the invoice / purchase order equivalent).
 */
@Module({
  providers: [
    {
      provide: STORAGE_ADAPTER,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) => new DiskStorageAdapter(config.FILES_ROOT),
    },
    { provide: LOGO_DOCUMENT_LOOKUP, inject: [DB], useFactory: drizzleLogoDocumentLookup },
    DocumentLogoResolverFactory,
  ],
  exports: [DocumentLogoResolverFactory],
})
export class DocumentLogoModule {}
