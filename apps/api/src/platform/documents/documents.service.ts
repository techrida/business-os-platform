// The documents service: create, receive, scan hand-off, read, signed links.
// Serves NFR Security ("no unscanned file is ever served"): every state change goes through here, and a
// download link is only ever issued for a version whose status is `clean`.
//
// Lifecycle of one version (status):
//   create()          -> awaiting_content   a row exists, no bytes yet
//   receiveContent()  -> quarantined        bytes on disk under quarantine/, type checked, docs.scan queued
//                     -> rejected           wrong type or too big (file deleted)
//   scan processor    -> clean | infected | scan_failed
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  ALLOWED_MIME,
  MAX_UPLOAD_BYTES,
  type CreateDocumentBody,
  type DocumentVersionDto,
  type SignedLinkDto,
} from '@bos/contracts';
import { documents, documentVersions, scoped } from '@bos/db';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import { withTx, requestTx, type Actor, type TxScope } from '../db/tx';
import type { ResourceRef } from '../authz/can';
import {
  AUDIT_PORT,
  AUTHZ_PORT,
  DOCS_SCAN_JOB,
  DOCS_SCAN_QUEUE,
  SCAN_ATTEMPTS,
  type AuditPort,
  type AuthzPort,
  type DocumentOwnerPolicy,
  type ScanJobData,
} from './documents.ports';
import { LinkError, SignedLinks } from './signed-link';
import {
  PayloadTooLargeError,
  STORAGE_ADAPTER,
  StoredFileNotFoundError,
  type StorageAdapter,
} from './storage.adapter';
import { actorUuid, readTxContext } from './tx-context';
import { checkType, isAllowedMime } from './type-check';

type VersionRow = typeof documentVersions.$inferSelect;
/** Anything that can run a SELECT: the pool-backed Db or an open transaction. */
type Reader = Pick<Db, 'select'>;

export interface DocumentDto {
  id: string;
  ownerType: string;
  ownerId: string;
  currentVersionId: string | null;
  createdAt: string;
  versions: DocumentVersionDto[];
}

export interface DownloadHandle {
  stream: Readable;
  filename: string;
  mime: string;
  size: number;
}

export function toVersionDto(v: VersionRow): DocumentVersionDto {
  return {
    id: v.id,
    documentId: v.documentId,
    version: v.version,
    filename: v.filename,
    declaredMime: v.declaredMime,
    detectedMime: v.detectedMime,
    sizeBytes: v.sizeBytes,
    sha256: v.sha256 === null ? null : v.sha256.toString('hex'),
    status: v.status,
    scanSignature: v.scanSignature,
    scannedAt: v.scannedAt === null ? null : v.scannedAt.toISOString(),
    uploadedBy: v.uploadedBy,
    createdAt: v.createdAt.toISOString(),
  };
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly owners = new Map<string, DocumentOwnerPolicy>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly links: SignedLinks,
    @InjectQueue(DOCS_SCAN_QUEUE) private readonly queue: Queue,
    @Inject(AUTHZ_PORT) private readonly authz: AuthzPort,
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
  ) {}

  /** A module that owns records with attachments registers how to authorize them (U8: 'test_memo'). */
  registerOwner(policy: DocumentOwnerPolicy): void {
    if (this.owners.has(policy.ownerType)) {
      throw new Error(`document owner type "${policy.ownerType}" is already registered`);
    }
    this.owners.set(policy.ownerType, policy);
  }

  // ------------------------------------------------------------------------------------------ create

  /** Creates the document and its version 1 (status awaiting_content). Runs in the caller's transaction. */
  async create(
    tx: DbTransaction,
    b: CreateDocumentBody,
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    const who = await readTxContext(tx);
    if (!this.owners.has(b.ownerType)) {
      throw new BadRequestException(`Unknown owner type: ${b.ownerType}`);
    }
    // Permission first: someone who may not upload learns nothing about types or limits.
    await this.assertOwner(who.scope, b.ownerType, b.ownerId, 'documents.upload');
    if (!isAllowedMime(b.declaredMime)) {
      throw new UnsupportedMediaTypeException(
        `File type ${b.declaredMime} is not allowed. Allowed: ${ALLOWED_MIME.join(', ')}`,
      );
    }
    if (b.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(`File is larger than ${MAX_UPLOAD_BYTES} bytes`);
    }

    const s = scoped(who.scope);
    const actor = actorUuid(who);
    const documentId = randomUUID();
    const versionId = randomUUID();
    await tx.insert(documents).values(
      s.values({
        id: documentId,
        ownerType: b.ownerType,
        ownerId: b.ownerId,
        createdBy: actor,
      }),
    );
    await tx.insert(documentVersions).values(
      s.values({
        id: versionId,
        documentId,
        version: 1,
        filename: b.filename,
        declaredMime: b.declaredMime,
        sizeBytes: b.sizeBytes,
        storageKey: `${who.scope.tenantId}/${versionId}`,
        status: 'awaiting_content' as const,
        uploadedBy: actor,
      }),
    );
    return {
      documentId,
      versionId,
      uploadPath: `/v1/documents/${documentId}/versions/${versionId}/content`,
    };
  }

  // -------------------------------------------------------------------------------------- receive

  /**
   * Takes the file bytes, quarantines them, checks the type and queues the scan.
   * `opts.who` is the request's scope and actor (default: requestTx(), HTTP only); tests pass their own.
   */
  async receiveContent(
    versionId: string,
    src: Readable,
    contentLength: number,
    opts: { documentId?: string; who?: { scope: TxScope; actor: Actor } } = {},
  ): Promise<DocumentVersionDto> {
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      throw new BadRequestException('Content-Length must be a non-negative integer');
    }
    // First cap: the declared length, before a single byte is read.
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(`File is larger than ${MAX_UPLOAD_BYTES} bytes`);
    }
    const who = opts.who ?? requestTx();
    const s = scoped(who.scope);

    // Step 1, one short transaction: check, then claim the version. The row lock makes the claim atomic, so
    // two uploads of the same version cannot both pass: the second sees `quarantined` and gets 409.
    const row = await withTx(this.db, who.scope, who.actor, async (tx) => {
      const found = await this.loadVersion(tx, who.scope, versionId, opts.documentId, true);
      await this.assertOwner(who.scope, found.ownerType, found.ownerId, 'documents.upload');
      if (found.version.status !== 'awaiting_content') {
        throw new ConflictException('Content was already received for this version');
      }
      if (contentLength !== found.version.sizeBytes) {
        throw new BadRequestException('Content-Length must equal the sizeBytes declared at create');
      }
      await tx
        .update(documentVersions)
        .set({ status: 'quarantined', updatedAt: new Date() })
        .where(s.where(documentVersions, eq(documentVersions.id, versionId)));
      return found;
    });
    const { version } = row;

    // Step 2: stream to disk. Second cap: the bytes actually counted (a lying client, or chunked encoding).
    let written;
    try {
      written = await this.storage.writeQuarantine(version.storageKey, src, MAX_UPLOAD_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        await this.reject(who, version, { reason: 'too_large', detectedMime: null, sha256: null });
        throw new PayloadTooLargeException(`File is larger than ${MAX_UPLOAD_BYTES} bytes`);
      }
      await this.reopen(who, version);
      this.logger.warn(`upload of version ${versionId} did not finish: ${describe(error)}`);
      throw new BadRequestException('The upload was interrupted. Send the content again.');
    }
    if (written.bytes !== contentLength) {
      await this.reopen(who, version);
      throw new BadRequestException('The body length did not match Content-Length. Send it again.');
    }

    // Step 3: the type check, on the quarantined file.
    const verdict = await checkType(
      this.storage.quarantinePath(version.storageKey),
      written.head,
      version.declaredMime,
    );
    if (!verdict.ok) {
      await this.reject(who, version, {
        reason: verdict.reason,
        detectedMime: verdict.detectedMime,
        sha256: written.sha256,
      });
      throw new UnsupportedMediaTypeException(
        `The file content does not match its declared type: ${verdict.reason}`,
      );
    }

    // Step 4: record what was received. Status stays `quarantined` until the scan says otherwise.
    const updated = await withTx(this.db, who.scope, who.actor, async (tx) => {
      const [saved] = await tx
        .update(documentVersions)
        .set({
          sha256: written.sha256,
          sizeBytes: written.bytes,
          detectedMime: verdict.detectedMime,
          updatedAt: new Date(),
        })
        .where(s.where(documentVersions, eq(documentVersions.id, versionId)))
        .returning();
      if (saved === undefined) throw new NotFoundException('Version not found');
      return saved;
    });

    // Step 5: queue the scan AFTER the commit, so the worker always finds the row.
    const job: ScanJobData = {
      versionId,
      tenantId: who.scope.tenantId,
      organizationId: who.scope.organizationId,
    };
    try {
      await this.queue.add(DOCS_SCAN_JOB, job, {
        // The version id as job id: queueing the same version twice is a no-op, not two scans.
        jobId: versionId,
        attempts: SCAN_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    } catch (error) {
      // Without a job the file would sit in quarantine forever. Undo, so the client can simply retry.
      this.logger.error(`could not queue the scan for version ${versionId}: ${describe(error)}`);
      await this.storage.removeQuarantine(version.storageKey);
      await this.reopen(who, version);
      throw new ServiceUnavailableException(
        'The virus scanner queue is unavailable. Try again shortly.',
      );
    }
    return toVersionDto(updated);
  }

  // ------------------------------------------------------------------------------------------ read

  async get(scope: TxScope, documentId: string): Promise<DocumentDto> {
    const s = scoped(scope);
    const [doc] = await this.db
      .select()
      .from(documents)
      .where(s.where(documents, eq(documents.id, documentId)))
      .limit(1);
    if (doc === undefined) throw new NotFoundException('Document not found');
    await this.assertOwner(scope, doc.ownerType, doc.ownerId, 'documents.read');
    const versions = await this.db
      .select()
      .from(documentVersions)
      .where(s.where(documentVersions, eq(documentVersions.documentId, documentId)))
      .orderBy(asc(documentVersions.version));
    return {
      id: doc.id,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId,
      currentVersionId: doc.currentVersionId,
      createdAt: doc.createdAt.toISOString(),
      versions: versions.map(toVersionDto),
    };
  }

  /** Versions of every document of one owner, oldest first. For the owning module, which authorized already. */
  async listForOwner(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
  ): Promise<DocumentVersionDto[]> {
    const s = scoped(scope);
    const rows = await this.db
      .select({ v: documentVersions })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        s.where(documents, and(eq(documents.ownerType, ownerType), eq(documents.ownerId, ownerId))),
      )
      .orderBy(asc(documentVersions.createdAt));
    return rows.map((r) => toVersionDto(r.v));
  }

  /**
   * True when every attachment of the owner is usable: for each document the newest version that was not
   * rejected must be `clean`. A rejected upload (wrong type, too big) was never an attachment, so it does not
   * block. An infected, failed or still-scanning one does.
   */
  async allClean(scope: TxScope, ownerType: string, ownerId: string): Promise<boolean> {
    const versions = await this.listForOwner(scope, ownerType, ownerId);
    const latest = new Map<string, DocumentVersionDto>();
    for (const v of versions) {
      if (v.status === 'rejected') continue;
      const seen = latest.get(v.documentId);
      if (seen === undefined || v.version > seen.version) latest.set(v.documentId, v);
    }
    return [...latest.values()].every((v) => v.status === 'clean');
  }

  // ---------------------------------------------------------------------------------------- links

  /** A 60 s single-use link for a clean version. 409 for any other status. */
  async issueLink(scope: TxScope, versionId: string, documentId?: string): Promise<SignedLinkDto> {
    const row = await this.loadVersion(this.db, scope, versionId, documentId);
    await this.assertOwner(scope, row.ownerType, row.ownerId, 'documents.read');
    if (row.version.status !== 'clean') {
      throw new ConflictException(
        `This file cannot be downloaded: its status is ${row.version.status}, not clean`,
      );
    }
    try {
      const { token, expiresAt } = this.links.issue(versionId);
      return { url: `/v1/files/${token}`, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof LinkError && error.kind === 'secret_missing') {
        // Fail closed: no secret means no links, never an unsigned or weakly signed one.
        throw new ServiceUnavailableException('Download links are not configured');
      }
      throw error;
    }
  }

  /**
   * Redeems a link and opens the file. This is the one read without a scope: the signed token IS the
   * credential (it was issued to someone who passed the read check), and the public route has no identity.
   */
  async openDownload(token: string): Promise<DownloadHandle> {
    let versionId: string;
    try {
      versionId = await this.links.redeem(token);
    } catch (error) {
      if (error instanceof LinkError)
        throw new UnauthorizedException('Invalid or expired download link');
      throw error;
    }
    const [v] = await this.db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    // The status is checked again here, not only when the link was issued.
    if (v === undefined || v.status !== 'clean') throw new NotFoundException('File not found');
    try {
      const stream = await this.storage.openClean(v.storageKey);
      return {
        stream,
        filename: v.filename,
        mime: v.detectedMime ?? 'application/octet-stream',
        size: v.sizeBytes,
      };
    } catch (error) {
      if (error instanceof StoredFileNotFoundError) throw new NotFoundException('File not found');
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------ internals

  private async assertOwner(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    action: 'documents.upload' | 'documents.read',
  ): Promise<void> {
    const policy = this.owners.get(ownerType);
    if (policy === undefined) {
      // A row whose owner module is not loaded: refuse rather than guess.
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const ref: ResourceRef | null = await policy.resource(scope, ownerId);
    if (ref === null) throw new NotFoundException('Owner record not found');
    this.authz.assert(action, ref);
  }

  private async loadVersion(
    q: Reader,
    scope: TxScope,
    versionId: string,
    documentId?: string,
    lock = false,
  ): Promise<{ version: VersionRow; ownerType: string; ownerId: string }> {
    const s = scoped(scope);
    const query = q
      .select({
        version: documentVersions,
        ownerType: documents.ownerType,
        ownerId: documents.ownerId,
      })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        s.where(
          documentVersions,
          and(
            eq(documentVersions.id, versionId),
            documentId === undefined ? undefined : eq(documentVersions.documentId, documentId),
          ),
        ),
      )
      .limit(1);
    // No `of`: Postgres only accepts an unqualified table name after FOR UPDATE OF, and Drizzle writes
    // "app"."document_versions". Locking the document row as well is harmless: one upload at a time per document.
    const [row] = await (lock ? query.for('update') : query);
    if (row === undefined) throw new NotFoundException('Version not found');
    return row;
  }

  /** Marks a version rejected, deletes its file and records the domain event. */
  private async reject(
    who: { scope: TxScope; actor: Actor },
    version: VersionRow,
    d: { reason: string; detectedMime: string | null; sha256: Buffer | null },
  ): Promise<void> {
    const s = scoped(who.scope);
    await withTx(this.db, who.scope, who.actor, async (tx) => {
      await tx
        .update(documentVersions)
        .set({
          status: 'rejected',
          detectedMime: d.detectedMime,
          sha256: d.sha256,
          updatedAt: new Date(),
        })
        .where(s.where(documentVersions, eq(documentVersions.id, version.id)));
      await this.audit.record(tx, {
        action: 'document.rejected',
        entityType: 'document_version',
        entityId: version.id,
        meta: {
          reason: d.reason,
          declaredMime: version.declaredMime,
          detectedMime: d.detectedMime,
        },
      });
    });
    await this.storage.removeQuarantine(version.storageKey);
  }

  /** Puts a half-received version back to awaiting_content so the client can send the content again. */
  private async reopen(who: { scope: TxScope; actor: Actor }, version: VersionRow): Promise<void> {
    const s = scoped(who.scope);
    await this.storage.removeQuarantine(version.storageKey);
    await withTx(this.db, who.scope, who.actor, async (tx) => {
      await tx
        .update(documentVersions)
        .set({ status: 'awaiting_content', updatedAt: new Date() })
        .where(s.where(documentVersions, eq(documentVersions.id, version.id)));
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
