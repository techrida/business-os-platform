// The documents service: create, receive, scan hand-off, read, signed links.
// Serves NFR Security ("no unscanned upload is ever served"; only bytes the system rendered itself skip the scan,
// D28): every state change goes through here, and a download link is only ever issued for a version whose status
// is `clean`.
//
// Removal is soft: documents.removed_at is set, nothing is deleted, and a removed document is invisible to every
// read here. Only the owner's `canAttach` decides whether someone may add to or remove from its attachments.
// One exception (U12): a picture (an image owner type: a company logo, a profile picture, a customer or vendor
// logo) is never removed through `remove`, the HTTP path, because a pointer may still name it. The images module
// moves the pointer and removes the previous picture itself (removeInTransaction, removeManagedImage).
//
// Lifecycle of one version (status):
//   create()          -> awaiting_content   a row exists, no bytes yet
//   receiveContent()  -> quarantined        bytes on disk under quarantine/, type checked, docs.scan queued
//                     -> rejected           wrong type or too big (file deleted)
//                     -> quarantined, no sha256   the write failed (interrupted, wrong length): stays so, never reopened
//   scan processor    -> clean | infected | scan_failed
//
// Generated files (a quotation PDF a job rendered) take the same road under the system actor, minus the scan
// (decision D28: bytes the system rendered itself are not scanned; uploads always are):
//   createGenerated() -> receiveGenerated() -> quarantine, type check, sha256, then straight to `clean`
//   (scan_engine 'generated', no docs.scan job, clamd never called), or `rejected` when it cannot be finished.
// Who is asked differs too: the owner's `allowsSystemActor`, not the request principal's authz. Only
// receiveGenerated can skip the scan; the HTTP-facing receiveContent never can.
//
// A portal caller (a customer) holds no `documents.upload`. `create` and `receiveContent` still let one upload
// when the owner's `allowsCounterparty` says yes (P3: payment proof on the customer's own payment). Every other
// refusal is the unchanged grant check, and `createVersion` and `remove` never ask the hook.
// The grant checked for an upload is `documents.upload` unless the owner policy names its own `uploadPermission`
// (payment proof: `payment.record`; a list means any one of them). A staff read needs `documents.read` or the
// owner policy's `readPermission`, on the owner ref. An owning module's route may also name the action the upload
// belongs to (`UploadAction`, U20a2-Q3); when the policy lists it in `uploadActions`, that action on the uploader's
// own file is enough (an `own` bill enterer uploads their own invoice), and the usual check still runs otherwise.
// An owner type that spans several record kinds names the grant per record instead (`uploadGrants`, round 5 P2:
// evidence on a sales order, a bill or an RFQ), so one kind's grant never reaches another kind's record.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  ALLOWED_MIME,
  CompanyProfileSchema,
  CreateDocumentBodySchema,
  IMAGE_MIME,
  isImageOwnerType,
  MAX_UPLOAD_BYTES,
  type CreateDocumentBody,
  type DocumentVersionDto,
  type Permission,
  type SignedLinkDto,
} from '@bos/contracts';
import { documents, documentVersions, organizations, scoped } from '@bos/db';
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
import { and, asc, desc, eq, inArray, isNull, max, or } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { z } from 'zod';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import { readSetting } from '../settings/settings.service';
import { withTx, requestTx, type Actor, type TxScope } from '../db/tx';
import type { Principal, ResourceRef } from '../authz/can';
import { currentPrincipal } from '../tenancy/request-context';
import {
  AUDIT_PORT,
  AUTHZ_PORT,
  COUNTERPARTY_KINDS,
  DOCS_SCAN_JOB,
  DOCS_SCAN_QUEUE,
  type AuditPort,
  type AuthzPort,
  type CounterpartyKind,
  type CounterpartyPrincipal,
  type DocumentOwnerPolicy,
  type ScanJobData,
} from './documents.ports';
import { isTenantWideImageOwner, TENANT_WIDE_IMAGE_OWNERS } from './image-scope';
import { GENERATED_ENGINE, markVersionClean, stillQuarantined } from './mark-version-clean';
import { ScanQueueDeferredError } from './scan-queue-deferred.error';
import { SCAN_JOB_OPTIONS } from './scan.processor';
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
/** The same id rule as the documents controller: anything else is refused before it reaches Postgres. */
const Id = z.guid();
/** The one refusal of issueLinkForOwner: the same body whether the document is missing, foreign or unclean. */
const OWNER_LINK_NOT_FOUND = 'File not found';
/** The one refusal of openImage: the same body whether the image is missing, foreign, removed or not clean yet. */
const IMAGE_NOT_FOUND = 'Image not found';

/** The refusal of a generic create or new version for a picture: only the images API uploads one. */
function picturesUploadedElsewhere(): ConflictException {
  return new ConflictException({
    code: 'conflict',
    message: 'Pictures are uploaded from their own settings.',
  });
}

/** The refusal of a generic new version or removal of a file its owning module manages (`ownRoutesOnly`). */
function managedByRecord(): ConflictException {
  return new ConflictException({
    code: 'conflict',
    message: 'This file is managed from its record: remove it there and upload a new one.',
  });
}

/** The refusal of a version's bytes from anyone but its uploader, for an `ownRoutesOnly` owner. */
function notVersionUploader(): ForbiddenException {
  return new ForbiddenException({
    code: 'forbidden',
    message: 'Only the person who started this upload can send its file.',
    reason: 'no_permission',
  });
}

/** Anything that can run a SELECT: the pool-backed Db or an open transaction. */
type Reader = Pick<Db, 'select'>;

/** Rejected bytes never became an attachment; the newest remaining version controls usability. */
export function newestNonRejected<T extends { version: number; status: string }>(
  versions: readonly T[],
): T | undefined {
  return versions.reduce<T | undefined>(
    (latest, version) =>
      version.status !== 'rejected' && (latest === undefined || version.version > latest.version)
        ? version
        : latest,
    undefined,
  );
}

/**
 * The refusal of an infected file where a record takes it (TR-Q12e): one code and one message everywhere, so every
 * screen can say what to do. The message does not name the file: an uploaded filename is user text, and the
 * refusal reaches people (and logs) the uploader did not choose.
 */
export function documentInfected(): ConflictException {
  return new ConflictException({
    code: 'document_infected',
    message: 'A virus was found in this file. Remove it or upload a clean copy, then try again.',
  });
}

/**
 * TR-Q12e: the server refuses an infected file wherever a record takes it (a bill's invoice, an evidence file, a
 * quotation document, a KYC file, a portal submission). Throws 409 `document_infected` when, for any of
 * `documentIds` in this scope, the newest version that was not rejected is `infected`. Call it after the caller's
 * own check that the ids are documents it may attach, in the same transaction, before writing the reference.
 * Only `infected` is refused here: a file still scanning (awaiting_content, quarantined) or whose scan failed may
 * still be saved on a draft as before, and each submit or approval step keeps its own rule that the file is clean.
 * Ids outside the scope, or with no versions, are left to the caller's own check (nothing is learned from them).
 */
export async function assertNotInfected(
  reader: Reader,
  scope: TxScope,
  documentIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(documentIds)].filter((id) => Id.safeParse(id).success);
  if (ids.length === 0) return;
  const versions = await reader
    .select({
      documentId: documentVersions.documentId,
      version: documentVersions.version,
      status: documentVersions.status,
    })
    .from(documentVersions)
    .where(scoped(scope).where(documentVersions, inArray(documentVersions.documentId, ids)));
  const byDocument = new Map<string, (typeof versions)[number][]>();
  for (const v of versions)
    byDocument.set(v.documentId, [...(byDocument.get(v.documentId) ?? []), v]);
  for (const id of ids) {
    const newest = newestNonRejected(byDocument.get(id) ?? []);
    if (newest?.status === 'infected') throw documentInfected();
  }
}

export async function newestDocumentVersion(reader: Reader, scope: TxScope, documentId: string) {
  const versions = await reader
    .select()
    .from(documentVersions)
    .where(scoped(scope).where(documentVersions, eq(documentVersions.documentId, documentId)));
  return newestNonRejected(versions);
}

export interface DocumentDto {
  id: string;
  ownerType: string;
  ownerId: string;
  currentVersionId: string | null;
  createdAt: string;
  versions: DocumentVersionDto[];
}

/** What a new version needs from the client: the owner and the document already exist. */
export type NewVersionBody = Pick<CreateDocumentBody, 'filename' | 'declaredMime' | 'sizeBytes'>;

/**
 * The owning module's action an upload belongs to (U20a2-Q3), passed by that module's own route and never read from
 * a request body. Only an action the owner policy lists in `uploadActions` counts; see that field.
 */
export interface UploadAction {
  action?: Permission | undefined;
}

/** A file a job generated: its bytes are in memory, so the size is known and nothing is declared by a client. */
export interface GeneratedFile {
  filename: string;
  declaredMime: string;
  bytes: Buffer;
}

export interface DownloadHandle {
  stream: Readable;
  filename: string;
  mime: string;
  size: number;
}

/**
 * What openImage gives back: the bytes, or (when the caller already holds this version) only the ETag, so the
 * controller answers 304 without the storage ever being opened. `etag` is the version id, unquoted.
 */
export type ImageHandle =
  | { notModified: true; etag: string }
  | { notModified: false; stream: Readable; mime: string; size: number; etag: string };

/**
 * Whether an `If-None-Match` header names this ETag: a single tag, quoted (`"id"`) or not, weak (`W/"id"`) or
 * strong (weak comparison, as RFC 9110 asks for If-None-Match), or a comma list of them.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((part) => {
    let tag = part.trim();
    if (tag.startsWith('W/')) tag = tag.slice(2);
    if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) tag = tag.slice(1, -1);
    return tag !== '' && tag === etag;
  });
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

  /**
   * Creates the document and its version 1 (status awaiting_content). Runs in the caller's transaction. Takes a
   * picture (an image owner type) too: `createAndReceiveUpload` (the images module) creates one this way. The generic
   * HTTP route uses `createFromRequest`, which refuses a picture.
   */
  async create(
    tx: DbTransaction,
    b: CreateDocumentBody,
    opts: UploadAction = {},
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    return this.createDocument(tx, b, false, opts.action);
  }

  /**
   * `create` for the generic `POST /v1/documents` (the controller only). A picture (an image owner type) is a 409,
   * after the permission check and before anything is written: a document created here would wait for bytes that
   * may never come and could still be set as the current picture, so pictures are uploaded only through the images
   * API (POST /v1/images/:ownerType/:ownerId), which creates, receives and scans in one request.
   */
  async createFromRequest(
    tx: DbTransaction,
    b: CreateDocumentBody,
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    return this.createDocument(tx, b, true);
  }

  private async createDocument(
    tx: DbTransaction,
    b: CreateDocumentBody,
    refuseImages: boolean,
    action?: Permission,
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    const who = await readTxContext(tx);
    if (!this.owners.has(b.ownerType)) {
      throw new BadRequestException(`Unknown owner type: ${b.ownerType}`);
    }
    // Permission first: someone who may not upload learns nothing about types or limits.
    // A new file is the uploader's own: it is created with created_by = them.
    await this.assertUploader(
      who.scope,
      b.ownerType,
      b.ownerId,
      { kind: who.actorKind, id: who.actorId },
      tx,
      { action, uploaderUserId: actorUuid(who) },
    );
    if (refuseImages && isImageOwnerType(b.ownerType)) throw picturesUploadedElsewhere();
    // Before anything is written: a record that stopped taking attachments gets no row and no file.
    await this.assertCanAttach(who.scope, b.ownerType, b.ownerId, tx);
    assertUploadAllowed(b, this.owners.get(b.ownerType));

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

  /**
   * Creates the document and its version 1 (awaiting_content) for a file a background job generated, in the
   * caller's transaction. That transaction must run under the system actor (`withTx(db, scope,
   * systemActor('<job>'), ...)`): a user transaction is refused, so this can never be used to skip the
   * principal's authz check. The owner's `allowsSystemActor` must say yes (it is absent by default, which is
   * no), and an owner that does not exist in this scope is a 404. A refusal writes no row.
   *
   * The bytes are NOT written here: the row must be committed first, because the content step opens its own
   * transactions and the scan worker reads the row. Call `receiveGenerated` after the commit.
   */
  async createGenerated(
    tx: DbTransaction,
    owner: { ownerType: string; ownerId: string },
    file: GeneratedFile,
  ): Promise<{ documentId: string; versionId: string }> {
    const who = await readTxContext(tx);
    if (who.actorKind !== 'system') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const parsed = CreateDocumentBodySchema.safeParse({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      filename: file.filename,
      declaredMime: file.declaredMime,
      // A zero-byte file fails `positive()`: an empty generated file is a bug in the job, not a document.
      sizeBytes: file.bytes.length,
    });
    if (!parsed.success) {
      throw new BadRequestException(`Invalid generated file: ${parsed.error.message}`);
    }
    const b = parsed.data;
    if (!this.owners.has(b.ownerType)) {
      throw new BadRequestException(`Unknown owner type: ${b.ownerType}`);
    }
    await this.assertSystemOwner(
      who.scope,
      b.ownerType,
      b.ownerId,
      { kind: 'system', id: who.actorId },
      tx,
    );
    assertUploadAllowed(b, this.owners.get(b.ownerType));

    const s = scoped(who.scope);
    const documentId = randomUUID();
    const versionId = randomUUID();
    await tx.insert(documents).values(
      s.values({
        id: documentId,
        ownerType: b.ownerType,
        ownerId: b.ownerId,
        createdBy: actorUuid(who),
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
        uploadedBy: actorUuid(who),
      }),
    );
    return { documentId, versionId };
  }

  /**
   * Hands the bytes of a generated file (from `createGenerated`, after its transaction committed) to the
   * receive pipeline: quarantine, type check against the declared type and sha256, exactly like an upload.
   * Then it SKIPS the virus scan (decision D28: the system rendered these bytes itself): the file is promoted
   * to clean storage and the version is marked `clean` with scan_engine 'generated' and a `document.scanned`
   * audit event (result 'generated'). Nothing is queued and clamd is never called.
   * `who` must be a system actor (anything else is a 403, so a request principal can never skip the scan); the
   * owner is asked again through `allowsSystemActor`. This is the only caller of the skip: `receiveContent`,
   * which the HTTP controller uses, always scans.
   * If promoting or the database update fails, the version is refused (`rejected`, bytes deleted) and the error is
   * thrown, so the render job counts a failed try and renders again (see finishGenerated). Only when the refusal
   * cannot be written either does it stay `quarantined`, with the scan queued as the fallback.
   */
  async receiveGenerated(
    created: { documentId: string; versionId: string },
    file: GeneratedFile,
    who: { scope: TxScope; actor: Actor },
  ): Promise<DocumentVersionDto> {
    if (who.actor.kind !== 'system') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    return this.receiveInternal(
      created.versionId,
      Readable.from(file.bytes),
      file.bytes.length,
      { documentId: created.documentId, who },
      { skipScan: true },
    );
  }

  /**
   * Creates a document from bytes a background job holds but did NOT render itself (U12: the legacy-logo migrator
   * moving a stored data URL into an `entity_logo` document), then receives them through the ordinary pipeline:
   * quarantine, type check, sha256 and a queued docs.scan job. The scan is never skipped: these bytes came from a
   * user once, so they are an upload, not a generated file (D28 does not apply).
   *
   * `who` must be a system actor (anything else is a 403 before anything is written). The create runs in its own
   * `withTx` under that actor and asks the owner's `allowsSystemActor`, exactly like `createGenerated`, including
   * the owner's type and size rules; it commits before the receive, which opens its own transactions.
   * Returns the ids; the version is `quarantined` until the scan worker marks it clean.
   *
   * If the receive fails after the create committed (wrong type: the version ends `rejected`; queue down: it stays
   * `quarantined` with its bytes for the sweeper), the live document stays behind and the error is thrown without its ids.
   */
  async createAndReceiveScanned(
    owner: { ownerType: string; ownerId: string },
    file: GeneratedFile,
    who: { scope: TxScope; actor: Actor },
  ): Promise<{ documentId: string; versionId: string }> {
    if (who.actor.kind !== 'system') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.createGenerated(tx, owner, file),
    );
    try {
      await this.receiveInternal(
        created.versionId,
        Readable.from(file.bytes),
        file.bytes.length,
        { documentId: created.documentId, who },
        { skipScan: false },
      );
    } catch (error) {
      // Received and kept: the sweeper queues its scan, so the document stands.
      if (!(error instanceof ScanQueueDeferredError)) throw error;
    }
    return created;
  }

  /**
   * Creates a document from bytes a signed-in user sent in one request (U12: `POST /v1/images/:ownerType/:ownerId`,
   * the image route, whose callers may hold the owner's grant but not `documents.upload`), then receives them through
   * the ordinary pipeline: quarantine, type check, sha256 and a queued docs.scan job. The scan is never skipped.
   *
   * `who` must be a user actor (a system actor is a 403 before anything is written; jobs use createAndReceiveScanned
   * or createGenerated). The create runs in its own `withTx`, so the owner's upload grant, `canAttach` and its type
   * and size rules are checked before any row exists; a bad file name or empty file is a 400.
   *
   * If the receive fails after the create committed (wrong type: 415; queue down: 503), the new document is removed
   * (best effort, logged when that fails too) and the receive's error is thrown.
   */
  async createAndReceiveUpload(
    owner: { ownerType: string; ownerId: string },
    file: GeneratedFile,
    who: { scope: TxScope; actor: Actor },
  ): Promise<{ documentId: string; versionId: string }> {
    if (who.actor.kind === 'system') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const parsed = CreateDocumentBodySchema.safeParse({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      filename: file.filename,
      declaredMime: file.declaredMime,
      // A zero-byte file fails `positive()`.
      sizeBytes: file.bytes.length,
    });
    if (!parsed.success) {
      throw new BadRequestException(`Invalid upload: ${parsed.error.message}`);
    }
    const body = parsed.data;
    const created = await withTx(this.db, who.scope, who.actor, (tx) => this.create(tx, body));
    try {
      await this.receiveContent(created.versionId, Readable.from(file.bytes), file.bytes.length, {
        documentId: created.documentId,
        who,
      });
    } catch (error) {
      try {
        await this.removeManagedImage(created.documentId, { who });
      } catch (cleanup) {
        this.logger.warn(
          `upload of document ${created.documentId} failed and it could not be removed: ${describe(cleanup)}`,
        );
      }
      // The picture is removed with its bytes and the sweeper skips removed documents, so no scan will follow.
      if (error instanceof ScanQueueDeferredError)
        throw new ServiceUnavailableException(
          'The picture could not be queued for its virus scan and was not saved. Upload it again.',
        );
      throw error;
    }
    return { documentId: created.documentId, versionId: created.versionId };
  }

  /**
   * Adds version N+1 to an existing document (status awaiting_content). Runs in the caller's transaction.
   * Allowed on top of any earlier version, in particular an infected or scan_failed one: that is the way out
   * of a bad attachment. `allClean` only looks at the newest version that was not rejected.
   * A picture (an image owner type) is a 409, after the permission check and before the lock and any write: its
   * newest version is what the images API serves, so an unfinished version 2 would hide a clean picture. No images
   * path adds versions; a new picture is a new document.
   */
  async createVersion(
    tx: DbTransaction,
    documentId: string,
    b: NewVersionBody,
    opts: UploadAction = {},
  ): Promise<{ documentId: string; versionId: string; uploadPath: string }> {
    const who = await readTxContext(tx);
    const s = scoped(who.scope);
    // Lock the owning records before the document, matching submit's owner -> document order.
    // The document lock then serializes version numbers: 1, 2, 3, ...
    const doc = await this.loadDocument(tx, who.scope, documentId);
    // A new version of a file is its creator's own.
    const byAction = await this.passesUploadAction(who.scope, doc.ownerType, doc.ownerId, {
      action: opts.action,
      uploaderUserId: doc.createdBy,
    });
    if (!byAction) {
      await this.assertOwner(who.scope, doc.ownerType, doc.ownerId, 'documents.upload');
    }
    if (this.owners.get(doc.ownerType)?.ownRoutesOnly === true) throw managedByRecord();
    await this.assertCanAttach(who.scope, doc.ownerType, doc.ownerId, tx, documentId);
    if (isImageOwnerType(doc.ownerType)) throw picturesUploadedElsewhere();
    await this.loadDocument(tx, who.scope, documentId, true);
    // The owner's narrower rules too.
    assertUploadAllowed(b, this.owners.get(doc.ownerType));

    const [top] = await tx
      .select({ latest: max(documentVersions.version) })
      .from(documentVersions)
      .where(s.where(documentVersions, eq(documentVersions.documentId, documentId)));
    const versionId = randomUUID();
    await tx.insert(documentVersions).values(
      s.values({
        id: versionId,
        documentId,
        version: (top?.latest ?? 0) + 1,
        filename: b.filename,
        declaredMime: b.declaredMime,
        sizeBytes: b.sizeBytes,
        storageKey: `${who.scope.tenantId}/${versionId}`,
        status: 'awaiting_content' as const,
        uploadedBy: actorUuid(who),
      }),
    );
    return {
      documentId,
      versionId,
      uploadPath: `/v1/documents/${documentId}/versions/${versionId}/content`,
    };
  }

  /**
   * Soft-removes a document: whoever may upload to the owner can remove an attachment while the owner still
   * takes attachments. That covers the stuck ones (infected, scan_failed, interrupted upload, quarantined
   * and never scanned) and a clean file on a draft. There is no age limit for a quarantined version: the
   * owner's canAttach is the gate, and a scan finishing on a removed document changes nothing anyone can see.
   * Rows are kept (audit); only the not-yet-clean bytes are deleted.
   * A picture (an image owner type) is a 409 here, after the permission check and before anything is written: a
   * pointer may still name it, so only the images API (PUT /v1/images/:ownerType/:ownerId) removes one.
   * `opts.who` is the request's scope and actor (default: requestTx(), HTTP only); tests pass their own.
   */
  async remove(
    documentId: string,
    opts: { who?: { scope: TxScope; actor: Actor } } = {},
  ): Promise<void> {
    await this.removeAndCleanUp(documentId, opts.who ?? requestTx(), true);
  }

  /**
   * `remove` without the picture refusal, for the images module only (no controller calls it): it removes an image
   * document that no pointer names yet, after its upload or pointer move failed. Same checks and cleanup otherwise.
   */
  async removeManagedImage(
    documentId: string,
    opts: { who: { scope: TxScope; actor: Actor } },
  ): Promise<void> {
    await this.removeAndCleanUp(documentId, opts.who, false);
  }

  private async removeAndCleanUp(
    documentId: string,
    who: { scope: TxScope; actor: Actor },
    genericRoute: boolean,
  ): Promise<void> {
    const unclean = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.removeDocument(tx, who.scope, documentId, genericRoute),
    );
    await this.cleanupRemoved(unclean);
  }

  /**
   * The staff upload check of an owner, for a caller that changes which of its documents is current (U12: the image
   * pointer routes): the owner must exist in the scope (404) and the request principal must hold the policy's upload
   * grant against its ref (403). The same check `create` and `remove` make; an unregistered owner type is a 403.
   */
  async assertCanManage(scope: TxScope, ownerType: string, ownerId: string): Promise<void> {
    await this.assertOwner(scope, ownerType, ownerId, 'documents.upload');
  }

  /**
   * The removal itself, inside the caller's transaction. A tenant-wide image (image-scope.ts: a profile picture, a
   * customer or vendor logo) may have been uploaded in another entity of the tenant: it is found by tenant alone, the
   * owner policy still decides with the caller's scope, and its rows are written under the entity they carry.
   * Removes a picture too: the images module calls this while it moves the pointer in the same transaction.
   */
  async removeInTransaction(tx: DbTransaction, scope: TxScope, documentId: string) {
    return this.removeDocument(tx, scope, documentId, false);
  }

  /** `genericRoute`: the generic DELETE route, which refuses pictures and `ownRoutesOnly` owners' files. */
  private async removeDocument(
    tx: DbTransaction,
    scope: TxScope,
    documentId: string,
    genericRoute: boolean,
  ) {
    const doc = await this.loadDocument(tx, scope, documentId, false, true);
    await this.assertOwner(scope, doc.ownerType, doc.ownerId, 'documents.upload');
    // After the permission check (someone who may not remove learns nothing), before the lock and any write.
    if (genericRoute && this.owners.get(doc.ownerType)?.ownRoutesOnly === true) {
      throw managedByRecord();
    }
    await this.assertCanAttach(scope, doc.ownerType, doc.ownerId, tx, documentId);
    if (genericRoute && isImageOwnerType(doc.ownerType)) {
      throw new ConflictException({
        code: 'conflict',
        message: 'This picture is managed from its own settings: replace or remove it there.',
      });
    }
    await this.loadDocument(tx, scope, documentId, true, true);
    // The document's own entity: the caller's, except for a tenant-wide image uploaded in another one.
    const s = scoped({ tenantId: scope.tenantId, organizationId: doc.organizationId });
    const versions = await tx
      .select()
      .from(documentVersions)
      .where(s.where(documentVersions, eq(documentVersions.documentId, documentId)))
      .orderBy(asc(documentVersions.version));
    const now = new Date();
    await tx
      .update(documents)
      .set({ removedAt: now, updatedAt: now })
      .where(s.where(documents, eq(documents.id, documentId)));
    await this.audit.record(tx, {
      action: 'document.removed',
      entityType: 'document',
      entityId: documentId,
      meta: {
        ownerType: doc.ownerType,
        ownerId: doc.ownerId,
        versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status })),
      },
    });
    return versions.filter((v) => v.status === 'quarantined' || v.status === 'scan_failed');
  }

  async cleanupRemoved(unclean: (typeof documentVersions.$inferSelect)[]): Promise<void> {
    // After the commit, like the scan queueing: a failed delete leaves an unreachable file, never a live row.
    for (const v of unclean) {
      try {
        await this.storage.removeQuarantine(v.storageKey);
      } catch (error) {
        this.logger.warn(
          `removed document ${v.documentId}: could not delete the file of ${v.id}: ${describe(error)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------- receive

  /**
   * Takes the file bytes, quarantines them, checks the type and queues the scan. Always scans: this is what
   * the HTTP controller calls, and nothing a request carries can skip the scan.
   * `opts.who` is the request's scope and actor (default: requestTx(), HTTP only); tests pass their own.
   */
  async receiveContent(
    versionId: string,
    src: Readable,
    contentLength: number,
    opts: { documentId?: string; who?: { scope: TxScope; actor: Actor } } & UploadAction = {},
  ): Promise<DocumentVersionDto> {
    return this.receiveInternal(versionId, src, contentLength, opts, { skipScan: false });
  }

  /**
   * The receive steps. `flags.skipScan` is not reachable from outside the service: the public
   * `receiveContent` passes false and only `receiveGenerated` passes true. It also needs a system actor
   * here, so a bug in a caller still cannot skip the scan for a user.
   */
  private async receiveInternal(
    versionId: string,
    src: Readable,
    contentLength: number,
    opts: { documentId?: string; who?: { scope: TxScope; actor: Actor } } & UploadAction,
    flags: { skipScan: boolean },
  ): Promise<DocumentVersionDto> {
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      throw new BadRequestException('Content-Length must be a non-negative integer');
    }
    // First cap: the declared length, before a single byte is read.
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(`File is larger than ${MAX_UPLOAD_BYTES} bytes`);
    }
    const who = opts.who ?? requestTx();
    if (flags.skipScan && who.actor.kind !== 'system') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const s = scoped(who.scope);

    // Step 1, one short transaction: check, then claim the version. The row lock makes the claim atomic, so
    // two uploads of the same version cannot both pass: the second sees `quarantined` and gets 409.
    const row = await withTx(this.db, who.scope, who.actor, async (tx) => {
      let found = await this.loadVersion(tx, who.scope, versionId, opts.documentId);
      if (who.actor.kind === 'system') {
        // A generated file: the owner's system policy decides, never the request principal (there is none).
        await this.assertSystemOwner(who.scope, found.ownerType, found.ownerId, who.actor, tx);
      } else {
        // The bytes of a version are its uploader's own.
        await this.assertUploader(who.scope, found.ownerType, found.ownerId, who.actor, tx, {
          action: opts.action,
          uploaderUserId: found.version.uploadedBy,
        });
        if (
          this.owners.get(found.ownerType)?.ownRoutesOnly === true &&
          (who.actor.kind !== 'user' || found.version.uploadedBy !== who.actor.id)
        ) {
          throw notVersionUploader();
        }
        // The memo may have been submitted since the document was created: no bytes are written then.
        await this.assertCanAttach(
          who.scope,
          found.ownerType,
          found.ownerId,
          tx,
          found.version.documentId,
        );
      }
      found = await this.loadVersion(tx, who.scope, versionId, opts.documentId, true);
      if (found.version.status !== 'awaiting_content') {
        throw new ConflictException('Content was already received for this version');
      }
      if (contentLength !== found.version.sizeBytes) {
        throw new BadRequestException('Content-Length must equal the sizeBytes declared at create');
      }
      await tx
        .update(documentVersions)
        // A retry starts from nothing recorded: a validation marker is only ever written by this upload's own step 4.
        .set({ status: 'quarantined', detectedMime: null, updatedAt: new Date() })
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
      await this.failedWrite(who, version, flags);
      this.logger.warn(`upload of version ${versionId} did not finish: ${describe(error)}`);
      throw new BadRequestException(
        'The upload was interrupted. Start a new upload; this version cannot take the content again.',
      );
    }
    if (written.bytes !== contentLength) {
      await this.failedWrite(who, version, flags);
      throw new BadRequestException(
        'The body length did not match Content-Length. Start a new upload; this version cannot take the content again.',
      );
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
        .where(
          s.where(
            documentVersions,
            and(eq(documentVersions.id, versionId), eq(documentVersions.status, 'quarantined')),
          ),
        )
        .returning();
      if (saved === undefined) throw new NotFoundException('Version not found');
      return saved;
    });

    // Step 5 for a generated file (D28): no scan. Promote, then mark clean.
    if (flags.skipScan) return this.finishGenerated(who, updated);

    // Step 5: queue the scan AFTER the commit, so the worker always finds the row.
    const job: ScanJobData = {
      versionId,
      tenantId: who.scope.tenantId,
      organizationId: who.scope.organizationId,
    };
    try {
      await this.queue.add(DOCS_SCAN_JOB, job, {
        // The version id as job id: queueing the same version twice is a no-op, not two scans.
        // Seven attempts with exponential backoff (~30 min) ride out a short ClamAV outage (R7).
        ...SCAN_JOB_OPTIONS,
        jobId: versionId,
      });
    } catch (error) {
      // The bytes are stored and the version already holds their sha256 and `quarantined`, so the file is kept
      // (round 5, FU11): undoing it could end as a quarantined version with a sha256 and no bytes if the undo itself
      // half failed. The stuck-scan sweeper re-queues every version quarantined for over 15 minutes with no live
      // job, so the scan still happens. Sending the content again is a 409, as the content was received.
      this.logger.error(
        `could not queue the scan for version ${versionId}, the sweeper will: ${describe(error)}`,
      );
      throw new ScanQueueDeferredError(toVersionDto(updated));
    }
    return toVersionDto(updated);
  }

  /**
   * Steps 5-6 of a generated file (D28), in place of the scan: move the quarantined bytes to clean storage,
   * then mark the version clean in one transaction (same helper as the scan processor). `promote` is
   * idempotent and the update only applies to a still-quarantined version, so a retry finds either state and
   * never audits twice.
   *
   * A failure refuses the version instead of leaving it `quarantined` (round 5, S3): it becomes `rejected` with the
   * reason `generated_unfinished` and its bytes are deleted, then the original error is thrown. A rejected upload
   * holds no PDF, so the render job's own failure path counts the try, removes the document and renders again after
   * its pause. Left quarantined, the document would hold its owner on "Preparing PDF" until a scan finished it, and
   * a PDF that turned clean that way would skip the render's bookkeeping (an invoice's print row). Only when that
   * refusal cannot be written either (the database is away) does the version stay quarantined, with the scan queued
   * as the fallback (the sweeper re-queues it if that fails too), so it still ends `clean` through an ordinary scan.
   */
  private async finishGenerated(
    who: { scope: TxScope; actor: Actor },
    received: VersionRow,
  ): Promise<DocumentVersionDto> {
    try {
      await this.storage.promote(received.storageKey);
      const clean = await withTx(this.db, who.scope, who.actor, (tx) =>
        markVersionClean(tx, this.audit, who.scope, received, {
          result: GENERATED_ENGINE,
          engine: GENERATED_ENGINE,
        }),
      );
      // Null: it is no longer quarantined (a repeat finished it first). Report what is stored.
      if (clean !== null) return toVersionDto(clean);
      const found = await this.loadVersion(this.db, who.scope, received.id, received.documentId);
      return toVersionDto(found.version);
    } catch (error) {
      this.logger.error(
        `generated version ${received.id} could not be marked clean, refusing it: ${describe(error)}`,
      );
      const refused = await this.refuseUnfinishedGenerated(who, received);
      // It turned clean after all (the mark committed before the error): that is a success.
      if (refused !== null && refused.status === 'clean') return toVersionDto(refused);
      if (refused === null) await this.queueFallbackScan(who, received);
      throw error;
    }
  }

  /**
   * Marks a generated version that could not be finished `rejected`, audits it and deletes both copies of its bytes
   * (the promote may or may not have moved them). Returns the version as it stands afterwards (`rejected`, or `clean`
   * when it was finished meanwhile), or null when the refusal itself could not be written.
   */
  private async refuseUnfinishedGenerated(
    who: { scope: TxScope; actor: Actor },
    received: VersionRow,
  ): Promise<VersionRow | null> {
    const s = scoped(who.scope);
    let row: VersionRow;
    try {
      row = await withTx(this.db, who.scope, who.actor, async (tx) => {
        const [rejected] = await tx
          .update(documentVersions)
          .set({ status: 'rejected', updatedAt: new Date() })
          .where(s.where(documentVersions, stillQuarantined(received.id)))
          .returning();
        if (rejected === undefined) {
          return (await this.loadVersion(tx, who.scope, received.id, received.documentId)).version;
        }
        await this.audit.record(tx, {
          action: 'document.rejected',
          entityType: 'document_version',
          entityId: received.id,
          meta: {
            reason: 'generated_unfinished',
            declaredMime: received.declaredMime,
            detectedMime: received.detectedMime,
          },
        });
        return rejected;
      });
    } catch (error) {
      this.logger.error(
        `generated version ${received.id} could not be refused either, falling back to the scan: ${describe(error)}`,
      );
      return null;
    }
    if (row.status === 'rejected') {
      try {
        await this.storage.removeQuarantine(received.storageKey);
        await this.storage.removeClean(received.storageKey);
      } catch (error) {
        // The version is refused and never served; leftover bytes are only disk space.
        this.logger.warn(
          `could not delete the bytes of refused version ${received.id}: ${describe(error)}`,
        );
      }
    }
    return row;
  }

  /** Queues the ordinary scan for a generated version left quarantined. The sweeper re-queues it if this fails. */
  private async queueFallbackScan(
    who: { scope: TxScope; actor: Actor },
    received: VersionRow,
  ): Promise<void> {
    try {
      await this.queue.add(
        DOCS_SCAN_JOB,
        {
          versionId: received.id,
          tenantId: who.scope.tenantId,
          organizationId: who.scope.organizationId,
        } satisfies ScanJobData,
        { ...SCAN_JOB_OPTIONS, jobId: received.id },
      );
    } catch (queueError) {
      // The sweeper re-queues a quarantined version after 15 minutes with no live job.
      this.logger.error(
        `could not queue the fallback scan for version ${received.id}: ${describe(queueError)}`,
      );
    }
  }

  // ------------------------------------------------------------------------------------------ read

  async get(scope: TxScope, documentId: string): Promise<DocumentDto> {
    const s = scoped(scope);
    const [doc] = await this.db
      .select()
      .from(documents)
      .where(s.where(documents, and(eq(documents.id, documentId), isNull(documents.removedAt))))
      .limit(1);
    if (doc === undefined) throw new NotFoundException('Document not found');
    await this.assertOwner(scope, doc.ownerType, doc.ownerId, 'documents.read');
    return this.documentDto(scope, doc);
  }

  /**
   * One live document of an owner with its versions, for a caller that already authorised the read by the owner's own
   * grant (the evidence scan-status poll: the record's permission, not `documents.read`). Null when the document is not
   * a live one of exactly this owner in this scope.
   */
  async getOwnedBy(
    scope: TxScope,
    owner: { ownerType: string; ownerId: string },
    documentId: string,
  ): Promise<DocumentDto | null> {
    const [doc] = await this.db
      .select()
      .from(documents)
      .where(
        scoped(scope).where(
          documents,
          and(
            eq(documents.id, documentId),
            eq(documents.ownerType, owner.ownerType),
            eq(documents.ownerId, owner.ownerId),
            isNull(documents.removedAt),
          ),
        ),
      )
      .limit(1);
    return doc === undefined ? null : this.documentDto(scope, doc);
  }

  private async documentDto(
    scope: TxScope,
    doc: typeof documents.$inferSelect,
  ): Promise<DocumentDto> {
    const versions = await this.db
      .select()
      .from(documentVersions)
      .where(scoped(scope).where(documentVersions, eq(documentVersions.documentId, doc.id)))
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

  /**
   * Versions of every live (not removed) document of one owner, oldest first. For the owning module, which
   * authorized already.
   */
  async listForOwner(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    q: Db | DbTransaction = this.db,
  ): Promise<DocumentVersionDto[]> {
    const s = scoped(scope);
    const rows = await q
      .select({ v: documentVersions })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        s.where(
          documents,
          and(
            eq(documents.ownerType, ownerType),
            eq(documents.ownerId, ownerId),
            isNull(documents.removedAt),
          ),
        ),
      )
      .orderBy(asc(documentVersions.createdAt));
    return rows.map((r) => toVersionDto(r.v));
  }

  /**
   * True when every attachment of the owner is usable: for each document the newest version that was not
   * rejected must be `clean`. A rejected upload (wrong type, too big) was never an attachment, so it does not
   * block. An infected, failed or still-scanning one does, until it is removed or a newer version replaces it.
   * Removed documents are not looked at.
   */
  async allClean(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    q: Db | DbTransaction = this.db,
  ): Promise<boolean> {
    const versions = await this.listForOwner(scope, ownerType, ownerId, q);
    const latest = new Map<string, DocumentVersionDto>();
    for (const v of versions) {
      if (v.status === 'rejected') continue;
      const seen = latest.get(v.documentId);
      const newest = newestNonRejected(seen === undefined ? [v] : [seen, v]);
      if (newest !== undefined) latest.set(v.documentId, newest);
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
    return this.signLink(versionId);
  }

  /**
   * A 60 s single-use link for the newest version of one document of one owner. For the owning module, which
   * authorized the caller's access to the owner already: like `listForOwner`, this asks no permission. The
   * customer portal uses it for the quotation PDF, with `{ ownerType: 'quotation_version', ownerId: versionId }`
   * and the version's rendered document id, after its own visibility checks (customer principals hold no
   * `documents.read`, and must not: the generic route would show them draft versions).
   *
   * The document must be live, belong to exactly that owner, and sit in the scope's tenant and entity. Its
   * newest version (by number, whatever its status) must be `clean`: an older clean version behind a newer
   * quarantined one is not served. An owner type nobody registered is refused. Every refusal is the same 404,
   * never a 403, so the caller learns nothing about whether the document exists. The link is redeemed by
   * `openDownload`, like the one from `issueLink`.
   */
  async issueLinkForOwner(
    scope: TxScope,
    owner: { ownerType: string; ownerId: string },
    documentId: string,
  ): Promise<SignedLinkDto> {
    if (
      !this.owners.has(owner.ownerType) ||
      !Id.safeParse(owner.ownerId).success ||
      !Id.safeParse(documentId).success
    ) {
      throw new NotFoundException(OWNER_LINK_NOT_FOUND);
    }
    const s = scoped(scope);
    const [row] = await this.db
      .select({ version: documentVersions })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
      .where(
        and(
          s.where(
            documents,
            and(
              eq(documents.id, documentId),
              eq(documents.ownerType, owner.ownerType),
              eq(documents.ownerId, owner.ownerId),
              isNull(documents.removedAt),
            ),
          ),
          s.where(documentVersions),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    if (row === undefined || row.version.status !== 'clean') {
      throw new NotFoundException(OWNER_LINK_NOT_FOUND);
    }
    return this.signLink(row.version.id);
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
    const [found] = await this.db
      .select({ v: documentVersions })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(eq(documentVersions.id, versionId), isNull(documents.removedAt)))
      .limit(1);
    const v = found?.v;
    // The status and the removal are checked again here, not only when the link was issued.
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

  /**
   * Opens an image (a company logo, a profile picture, a customer or vendor logo) for `GET /v1/images/:documentId`.
   * Asks no permission: any signed-in staff principal of the tenant may see these (U12); the controller
   * authenticates and passes the request's scope. The document must be live, of an image owner type, in the scope's
   * tenant AND entity (a `user_avatar`, `customer_logo` or `vendor_logo` only in the tenant: people and parties
   * belong to the tenant, not one entity, see image-scope.ts), and its newest version (by number, whatever its status) must be `clean` with an image type.
   * Every refusal, including a file missing from storage, is the same 404 (never a 403), so the caller learns
   * nothing about whether the document exists. `etag` is the version id, unquoted: the caller quotes it.
   * When `ifNoneMatch` (the request's `If-None-Match`) names that version, the result is `notModified` and the
   * storage is never opened; every check above still runs first, so a 304 never answers for a refused image.
   */
  async openImage(scope: TxScope, documentId: string, ifNoneMatch?: string): Promise<ImageHandle> {
    if (!Id.safeParse(documentId).success) throw new NotFoundException(IMAGE_NOT_FOUND);
    // scoped() refuses an empty id; the entity filter is written here because a tenant-wide image skips it.
    const { tenantId, organizationId } = scoped(scope).scope;
    const sameEntityOrTenantWide = (table: typeof documents | typeof documentVersions) =>
      or(
        inArray(documents.ownerType, [...TENANT_WIDE_IMAGE_OWNERS]),
        eq(table.organizationId, organizationId),
      );
    const [row] = await this.db
      .select({
        ownerType: documents.ownerType,
        tenantId: documents.tenantId,
        organizationId: documents.organizationId,
        removedAt: documents.removedAt,
        version: documentVersions,
      })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documentVersions.tenantId, tenantId),
          sameEntityOrTenantWide(documents),
          sameEntityOrTenantWide(documentVersions),
          eq(documents.id, documentId),
          isNull(documents.removedAt),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    // The query already scopes and filters; the same rules again here, so a query change cannot widen what is served.
    if (
      row === undefined ||
      row.removedAt !== null ||
      row.tenantId !== tenantId ||
      (!isTenantWideImageOwner(row.ownerType) && row.organizationId !== organizationId) ||
      !isImageOwnerType(row.ownerType) ||
      row.version.status !== 'clean' ||
      row.version.detectedMime === null ||
      !(IMAGE_MIME as readonly string[]).includes(row.version.detectedMime)
    ) {
      throw new NotFoundException(IMAGE_NOT_FOUND);
    }
    if (etagMatches(ifNoneMatch, row.version.id))
      return { notModified: true, etag: row.version.id };
    try {
      const stream = await this.storage.openClean(row.version.storageKey);
      return {
        notModified: false,
        stream,
        mime: row.version.detectedMime,
        size: row.version.sizeBytes,
        etag: row.version.id,
      };
    } catch (error) {
      if (error instanceof StoredFileNotFoundError) throw new NotFoundException(IMAGE_NOT_FOUND);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------ internals

  /**
   * The bytes of the company logo for a caller with no session (R6Q20: the portal's and the workspace's header, and
   * emails). The address names only the tenant (its stable public handle); what is served is the logo the tenant's
   * default entity has set in its company profile now (`entity.profile`.logoDocumentId), so a replaced logo shows
   * in emails sent long ago and an uploaded-but-not-applied or older logo is never public. It serves that one
   * `entity_logo` document (never a variant, a picture, an avatar or any other file) as its newest version, which
   * must be clean and a PNG, JPEG or WebP: the same rule as `openImage`, so a replacement still being scanned
   * answers 404 rather than the clean version before it. Every refusal is the one IMAGE_NOT_FOUND 404.
   */
  async openPublicLogo(tenantId: string, ifNoneMatch?: string): Promise<ImageHandle> {
    if (!Id.safeParse(tenantId).success) throw new NotFoundException(IMAGE_NOT_FOUND);
    const [entity] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.isDefault, true)))
      .limit(1);
    if (entity === undefined) throw new NotFoundException(IMAGE_NOT_FOUND);
    const profile = CompanyProfileSchema.safeParse(
      (await readSetting(this.db, { tenantId, organizationId: entity.id }, 'entity.profile')).value,
    );
    const documentId = profile.success ? profile.data.logoDocumentId : null;
    if (documentId === null) throw new NotFoundException(IMAGE_NOT_FOUND);
    const [row] = await this.db
      .select({
        ownerType: documents.ownerType,
        tenantId: documents.tenantId,
        organizationId: documents.organizationId,
        removedAt: documents.removedAt,
        version: documentVersions,
      })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documentVersions.tenantId, tenantId),
          eq(documents.id, documentId),
          eq(documents.ownerType, 'entity_logo'),
          isNull(documents.removedAt),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    // The query already filters; the same rules again here, so a query change cannot widen what is served.
    if (
      row === undefined ||
      row.tenantId !== tenantId ||
      row.organizationId !== entity.id ||
      row.ownerType !== 'entity_logo' ||
      row.removedAt !== null ||
      row.version.status !== 'clean' ||
      row.version.detectedMime === null ||
      !(IMAGE_MIME as readonly string[]).includes(row.version.detectedMime)
    ) {
      throw new NotFoundException(IMAGE_NOT_FOUND);
    }
    if (etagMatches(ifNoneMatch, row.version.id))
      return { notModified: true, etag: row.version.id };
    try {
      const stream = await this.storage.openClean(row.version.storageKey);
      return {
        notModified: false,
        stream,
        mime: row.version.detectedMime,
        size: row.version.sizeBytes,
        etag: row.version.id,
      };
    } catch (error) {
      if (error instanceof StoredFileNotFoundError) throw new NotFoundException(IMAGE_NOT_FOUND);
      throw error;
    }
  }

  /** Signs a link to one version. Fails closed: no secret means no links, never an unsigned one. */
  private signLink(versionId: string): SignedLinkDto {
    try {
      const { token, expiresAt } = this.links.issue(versionId);
      return { url: `/v1/files/${token}`, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof LinkError && error.kind === 'secret_missing') {
        throw new ServiceUnavailableException('Download links are not configured');
      }
      throw error;
    }
  }

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
    if (action === 'documents.upload') await this.assertUploadGrant(policy, scope, ownerId, ref);
    else await this.assertReader(policy, scope, ownerId, ref);
  }

  /**
   * The staff read check on an owner that exists: `documents.read` or the policy's `readPermission` on `ref`. An owner
   * with per-record `uploadGrants` (round 5 P2: evidence) also lets whoever may add files to that record open them,
   * so the uploader can watch the scan of a file on a record someone else owns. A refusal is the read refusal.
   */
  private async assertReader(
    policy: DocumentOwnerPolicy,
    scope: TxScope,
    ownerId: string,
    ref: ResourceRef,
  ): Promise<void> {
    try {
      this.assertAnyOf(readPermissionsOf(policy), ref);
    } catch (refused) {
      if (!(refused instanceof ForbiddenException) || policy.uploadGrants === undefined) {
        throw refused;
      }
      try {
        await this.assertUploadGrant(policy, scope, ownerId, ref);
      } catch (error) {
        throw error instanceof ForbiddenException ? refused : error;
      }
    }
  }

  /**
   * The staff upload check on an owner that exists: the policy's per-record `uploadGrants` when it has them (any one
   * action allowed on its ref), else `uploadPermission` (or `documents.upload`) on `ref`. Every upload path (create,
   * receive, new version, remove, the image pointer routes) ends here.
   */
  private async assertUploadGrant(
    policy: DocumentOwnerPolicy,
    scope: TxScope,
    ownerId: string,
    ref: ResourceRef,
  ): Promise<void> {
    if (policy.uploadGrants === undefined) {
      this.assertAnyOf(uploadPermissionsOf(policy), ref);
      return;
    }
    const grants = await policy.uploadGrants(scope, ownerId);
    if (grants === null) throw new NotFoundException('Owner record not found');
    let first: ForbiddenException | undefined;
    for (const grant of grants) {
      try {
        this.authz.assert(grant.action, grant.ref);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        first ??= error;
      }
    }
    throw first ?? new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
  }

  /**
   * The route-level check of the generic read routes (GET /v1/documents/:id and its link), made before the row is
   * read. Those routes cannot know the owner until the document is loaded, so a staff caller passes with
   * `documents.read` or with the `readPermission` of any registered owner type; `assertOwner` then asks, on the owner
   * ref, for `documents.read` or that one owner's permission, so nobody opens more than before (a `vendor.read` holder
   * still cannot open a verification case file). Without this, a reviewer named by `verification.review` passed the
   * record check but was refused at the route. A portal caller is checked against `documents.read` alone: an owner's
   * `readPermission` is a staff read. The refusal is the `documents.read` one, so a caller holding none of them gets
   * the same 403 as before for a real, an unknown and a malformed id.
   */
  assertReadRoute(): void {
    const actions = new Set<Permission>(['documents.read']);
    if (currentPrincipal()?.orgKind === 'staff') {
      for (const policy of this.owners.values()) {
        if (policy.readPermission !== undefined) actions.add(policy.readPermission);
      }
    }
    this.assertAnyOf([...actions]);
  }

  /**
   * Passes when the caller may do any one of `actions` (on `ref`, when given). Otherwise throws the refusal of the
   * first one, so an owner with a single permission answers exactly as before.
   */
  private assertAnyOf(actions: readonly Permission[], ref?: ResourceRef): void {
    let first: ForbiddenException | undefined;
    for (const action of actions) {
      try {
        this.authz.assert(action, ref);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        first ??= error;
      }
    }
    throw first ?? new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
  }

  /**
   * assertOwner for `documents.upload` in create and receive, plus the one way around the grant: a portal
   * caller (see `counterpartyOf`) whom the owner's `allowsCounterparty` accepts. Staff, an unknown owner type
   * and a policy without the hook take the assertOwner path unchanged. A counterparty the hook refuses gets the
   * real grant check, which it fails, so every refusal is the same 403 body as before the hook existed.
   */
  private async assertUploader(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    actor: { kind: string; id: string },
    tx: DbTransaction,
    asAction?: { action: Permission | undefined; uploaderUserId: string | null },
  ): Promise<void> {
    if (await this.passesUploadAction(scope, ownerType, ownerId, asAction)) return;
    const policy = this.owners.get(ownerType);
    const counterparty =
      policy?.allowsCounterparty === undefined
        ? null
        : counterpartyOf(currentPrincipal(), scope, actor);
    if (counterparty === null || policy?.allowsCounterparty === undefined) {
      await this.assertOwner(scope, ownerType, ownerId, 'documents.upload');
      return;
    }
    const ref: ResourceRef | null = await policy.resource(scope, ownerId);
    if (ref === null) throw new NotFoundException('Owner record not found');
    // Called as a method, not detached: a policy class may use `this`.
    if (await policy.allowsCounterparty(counterparty, ownerId, tx)) return;
    await this.assertUploadGrant(policy, scope, ownerId, ref);
  }

  /**
   * True when the owning module named an action the owner policy lists in `uploadActions` (U20a2-Q3) and the caller
   * may do it on the uploader's own file (`ownerUserId: uploaderUserId`). False for no action, an action the policy
   * does not list, a file with no user uploader, or a refusal: the caller then takes the usual check. The owner must
   * exist in this scope either way: 404 otherwise, the same answer as the usual check.
   */
  private async passesUploadAction(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    asAction?: { action: Permission | undefined; uploaderUserId: string | null },
  ): Promise<boolean> {
    const action = asAction?.action;
    const policy = this.owners.get(ownerType);
    if (action === undefined || policy?.uploadActions?.includes(action) !== true) return false;
    const ref: ResourceRef | null = await policy.resource(scope, ownerId);
    if (ref === null) throw new NotFoundException('Owner record not found');
    if (asAction?.uploaderUserId == null) return false;
    try {
      this.authz.assert(action, { ...scope, ownerUserId: asAction.uploaderUserId });
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /**
   * The system path's twin of assertOwner: the owner must exist in this scope (404) and its policy must
   * allow the system actor (403). No policy, or a policy without `allowsSystemActor`, refuses.
   */
  private async assertSystemOwner(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx: DbTransaction,
  ): Promise<void> {
    const policy = this.owners.get(ownerType);
    if (policy?.allowsSystemActor === undefined) {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    const ref: ResourceRef | null = await policy.resource(scope, ownerId);
    if (ref === null) throw new NotFoundException('Owner record not found');
    // Called as a method, not detached: a policy class may use `this`.
    // Only who the actor is, not its request details (ip, correlation id): that is all a policy decides on.
    if (!(await policy.allowsSystemActor(scope, ownerId, { kind: actor.kind, id: actor.id }, tx))) {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
  }

  /** 409 when the owner no longer takes attachments. No canAttach on the policy means always allowed. */
  private async assertCanAttach(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    tx: DbTransaction,
    documentId?: string,
  ): Promise<void> {
    const policy = this.owners.get(ownerType);
    if (policy?.canAttach === undefined) return;
    // Called as a method, not detached: a policy class may use `this`.
    if (!(await policy.canAttach(scope, ownerId, tx, documentId))) {
      throw new ConflictException({
        code: 'conflict',
        message: 'This record no longer accepts attachments',
      });
    }
  }

  /**
   * A live (not removed) document of the caller's scope, optionally locked for the rest of the transaction.
   * `tenantWideImages` (removal only) also finds a tenant-wide image (image-scope.ts) of another entity of the
   * same tenant; every other document still has to be in the caller's entity.
   */
  private async loadDocument(
    tx: DbTransaction,
    scope: TxScope,
    documentId: string,
    lock = false,
    tenantWideImages = false,
  ): Promise<{
    id: string;
    ownerType: string;
    ownerId: string;
    organizationId: string;
    createdBy: string | null;
  }> {
    const s = scoped(scope);
    const live = and(eq(documents.id, documentId), isNull(documents.removedAt));
    const query = tx
      .select({
        id: documents.id,
        ownerType: documents.ownerType,
        ownerId: documents.ownerId,
        organizationId: documents.organizationId,
        createdBy: documents.createdBy,
      })
      .from(documents)
      .where(
        tenantWideImages
          ? and(
              eq(documents.tenantId, s.scope.tenantId),
              live,
              or(
                eq(documents.organizationId, s.scope.organizationId),
                inArray(documents.ownerType, [...TENANT_WIDE_IMAGE_OWNERS]),
              ),
            )
          : s.where(documents, live),
      )
      .limit(1);
    const [doc] = await (lock ? query.for('update') : query);
    if (doc === undefined) throw new NotFoundException('Document not found');
    return doc;
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
            isNull(documents.removedAt),
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

  /**
   * A failed write (an interrupted stream or a body that did not match Content-Length) keeps its version
   * `quarantined` with no sha256: it is never put back to `awaiting_content` (round 5, EF3), so a second PUT is a 409
   * and the retry is a new version. Only the partial bytes go. The scan sweeper skips a version without a recorded
   * sha256, so nothing scans or serves it; the uploader removes the document or supersedes it with a new version.
   * Best effort: a leftover partial file is harmless, and the failure the caller reports is the upload's own.
   */
  private async failedWrite(
    who: { scope: TxScope; actor: Actor },
    version: VersionRow,
    flags: { skipScan: boolean },
  ): Promise<void> {
    // A generated file has no person to start a new upload: it goes back to `awaiting_content`, as before, so the render
    // job's own cleanup (discard the unfilled document, render again) still finds it. A quarantined version with no
    // sha256 would count as filled for good.
    if (flags.skipScan) {
      await this.reopen(who, version);
      return;
    }
    try {
      await this.storage.removeQuarantine(version.storageKey);
    } catch (error) {
      this.logger.warn(
        `partial bytes of version ${version.id} could not be removed: ${describe(error)}`,
      );
    }
  }

  /** Puts a half-received generated version back to awaiting_content (no bytes kept), so the job can write it again. */
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

const isCounterpartyKind = (kind: string): kind is CounterpartyKind =>
  (COUNTERPARTY_KINDS as readonly string[]).includes(kind);

/**
 * The request's caller as a counterparty an owner policy may let upload, or null. Null for no bound principal
 * (a worker, a call outside a request), staff, an org kind outside COUNTERPARTY_KINDS, any status but `active`
 * (the grant check would answer inactive_user), no party, a principal of another tenant or entity than the
 * transaction, and a transaction actor that is not this user.
 */
function counterpartyOf(
  p: Principal | undefined,
  scope: TxScope,
  actor: { kind: string; id: string },
): CounterpartyPrincipal | null {
  if (p === undefined || !isCounterpartyKind(p.orgKind)) return null;
  if (p.status !== 'active' || p.partyId === null || p.partyId === '') return null;
  if (p.tenantId !== scope.tenantId || p.organizationId !== scope.organizationId) return null;
  if (actor.kind !== 'user' || actor.id !== p.userId) return null;
  return {
    kind: p.orgKind,
    userId: p.userId,
    partyId: p.partyId,
    tenantId: p.tenantId,
    organizationId: p.organizationId,
  };
}

/** The permissions that authorise an upload to this owner (any one of them): its own, or `documents.upload`. */
function uploadPermissionsOf(policy: DocumentOwnerPolicy): readonly Permission[] {
  const own = policy.uploadPermission;
  if (own === undefined) return ['documents.upload'];
  return typeof own === 'string' ? [own] : own;
}

/** The permissions that authorise a staff read of this owner's files: `documents.read`, plus the owner's own. */
function readPermissionsOf(policy: DocumentOwnerPolicy): readonly Permission[] {
  return policy.readPermission === undefined
    ? ['documents.read']
    : ['documents.read', policy.readPermission];
}

/**
 * The type and size rules for a declared upload, the same for a new document and a new version. An owner's
 * `allowedMime` and `maxBytes` only narrow the generic rules (images: PNG, JPEG, WebP up to 512 KiB).
 */
function assertUploadAllowed(
  b: { declaredMime: string; sizeBytes: number },
  policy?: Pick<DocumentOwnerPolicy, 'allowedMime' | 'maxBytes'>,
): void {
  const ownerMime = policy?.allowedMime;
  if (!isAllowedMime(b.declaredMime) || (ownerMime && !ownerMime.includes(b.declaredMime))) {
    const allowed = ownerMime ?? ALLOWED_MIME;
    throw new UnsupportedMediaTypeException(
      `File type ${b.declaredMime} is not allowed. Allowed: ${allowed.join(', ')}`,
    );
  }
  const limit = Math.min(policy?.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  if (b.sizeBytes > limit) {
    throw new PayloadTooLargeException(`File is larger than ${limit} bytes`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
