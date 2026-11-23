// Which image is current (U12, D33): serving an image to staff, and moving an owner's pointer to a new image.
// Images are documents (image-owner.policies.ts); the "current" one is a pointer on the owner:
//   entity_logo   -> setting `entity.profile`.logoDocumentId (versioned through SettingsService, so history is kept);
//   entity_logo_on_dark / entity_logo_on_light -> the same setting's logoOnDarkDocumentId / logoOnLightDocumentId
//   user_avatar   -> app.users.avatar_document_id
//   customer_logo -> app.customers.logo_document_id
//   vendor_logo   -> app.vendors.logo_document_id
// Serves the NFRs:
// - "deny by default": only staff read or write here; changing a pointer needs the owner type's upload grant on the
//   owner's ref (DocumentsService.assertCanManage, the check uploads use: 404 for an owner outside the scope, 403
//   without the grant), and the new document must be a live image of exactly that owner (404 otherwise);
// - "every change is audited and nothing is lost": the pointer moves, the previous image is soft-removed
//   (DocumentsService.removeInTransaction) and `image.set` / `image.removed` is recorded, all in one transaction.
//   This is the only way a picture is removed: DELETE /v1/documents/:id refuses one with 409, so no pointer is left
//   naming a removed document.
import type { Readable } from 'node:stream';

import {
  CreateDocumentBodySchema,
  ENTITY_LOGO_FIELD,
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  isEntityLogoOwnerType,
  isImageOwnerType,
  SetImageBodySchema,
  type CompanyProfile,
  type EntityLogoOwnerType,
  type ImageOwnerType,
} from '@bos/contracts';
import {
  customers,
  documents,
  documentVersions,
  logoImageStats,
  users,
  vendors,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { DocumentsService, type ImageHandle } from '../../platform/documents/documents.service';
import { isTenantWideImageOwner } from '../../platform/documents/image-scope';
import { SettingsService } from '../../platform/settings/settings.service';
import { measureLogo } from './logo-analysis';

/** The pointer owners that are rows (the entity logo, in all three slots, is a setting). */
export type RowImageOwnerType = Exclude<ImageOwnerType, EntityLogoOwnerType>;

/** A live document of the tenant, as the pointer write needs it. */
export interface ImageDocumentRow {
  id: string;
  ownerType: string;
  ownerId: string;
  organizationId: string;
  /** Status of the newest version (by number), or null when the document has no version. */
  status: string | null;
}

/** The SQL behind the pointer write, so the rules in ImagesService are unit-tested without a database. */
export interface ImagePointerStore {
  /** The live (not removed) document `documentId` of the scope's tenant, locked for the transaction. */
  findDocument(
    tx: DbTransaction,
    scope: TxScope,
    documentId: string,
  ): Promise<ImageDocumentRow | undefined>;
  /** Locks the owner row and reads its pointer; undefined when the row does not exist in the tenant. */
  readPointer(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: RowImageOwnerType,
    ownerId: string,
  ): Promise<{ documentId: string | null } | undefined>;
  writePointer(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: RowImageOwnerType,
    ownerId: string,
    documentId: string | null,
  ): Promise<void>;
}

export const IMAGE_POINTER_STORE = Symbol('IMAGE_POINTER_STORE');

/** The request's scope, actor and principal: the controller builds it from the request context. */
export interface ImageCaller {
  scope: TxScope;
  actor: Actor;
  principal: Principal | undefined;
}

/**
 * The raw request of `POST /v1/images/:ownerType/:ownerId` (the controller passes the headers untouched): the body is
 * the image bytes, `contentType` its mime, `fileNameHeader` the percent-encoded `x-file-name`.
 */
export interface ImageUploadRequest {
  contentType: string | undefined;
  contentLength: string | undefined;
  fileNameHeader: string | undefined;
  stream: Readable;
}

const LOGO_VARIANT = {
  entity_logo: 'primary',
  entity_logo_on_dark: 'on_dark',
  entity_logo_on_light: 'on_light',
} as const satisfies Record<EntityLogoOwnerType, 'primary' | 'on_dark' | 'on_light'>;

const IMAGE_MIMES: ReadonlySet<string> = new Set(IMAGE_MIME);
const TOO_LARGE = `The image is larger than ${IMAGE_MAX_BYTES} bytes`;

/** The bare, lower-cased mime of a Content-Type header (parameters dropped), or 415 when it is not an image type. */
function imageMimeOf(contentType: string | undefined): string {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!IMAGE_MIMES.has(mime)) {
    throw new UnsupportedMediaTypeException(
      `Image type ${mime || '(none)'} is not allowed. Allowed: ${IMAGE_MIME.join(', ')}`,
    );
  }
  return mime;
}

/** The decoded `x-file-name`, under the same rule as a documents create body; 400 otherwise. */
function fileNameOf(header: string | undefined): string {
  let decoded: string | undefined;
  try {
    decoded = header === undefined || header === '' ? undefined : decodeURIComponent(header);
  } catch {
    decoded = undefined;
  }
  if (
    decoded === undefined ||
    !CreateDocumentBodySchema.shape.filename.safeParse(decoded).success
  ) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'Header x-file-name must be a percent-encoded file name without path separators',
    });
  }
  return decoded;
}

/** 413 when a declared Content-Length is over the image cap; 400 when it is not a non-negative integer. */
function assertDeclaredLength(header: string | undefined): void {
  if (header === undefined) return; // Chunked: the counting reader enforces the cap.
  if (!/^\d+$/.test(header.trim())) {
    throw new BadRequestException('Content-Length must be a non-negative integer');
  }
  if (Number(header.trim()) > IMAGE_MAX_BYTES) throw new PayloadTooLargeException(TOO_LARGE);
}

/**
 * Reads the whole body, at most `cap` bytes. Event listeners, not `for await`: leaving a for-await loop destroys the
 * stream (the socket), and the client would never see the 413. Over the cap the listeners are detached and the rest
 * of the body is drained and discarded, so the response can still be written. Settles exactly once on every path.
 */
export function readCapped(stream: Readable, cap: number): Promise<Buffer> {
  if (stream.readableEnded || stream.destroyed) {
    // Nothing left to read (an earlier body parser, or a closed connection): an empty body.
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const detach = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    const interrupted = () =>
      new BadRequestException('The upload was interrupted. Send the image again.');
    function onData(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > cap) {
        settle(() => {
          chunks.length = 0;
          // A late error on the discarded rest must not become an unhandled 'error' event.
          stream.on('error', () => undefined);
          stream.resume();
          reject(new PayloadTooLargeException(TOO_LARGE));
        });
        return;
      }
      chunks.push(buf);
    }
    function onEnd() {
      settle(() => resolve(Buffer.concat(chunks, total)));
    }
    function onError() {
      settle(() => reject(interrupted()));
    }
    function onClose() {
      // 'close' after 'end' is already settled; before it, the client went away mid-body.
      settle(() => reject(interrupted()));
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

/**
 * The only version states a picture may be set from: the bytes were received and passed the type check (the scan
 * then runs, or ran clean). Anything else, including a document still waiting for bytes, is a 409.
 */
const USABLE_STATUSES: ReadonlySet<string> = new Set(['quarantined', 'clean']);
/** Version states that can never become a picture: the bytes were refused or carry a virus. */
const REFUSED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'infected']);
const Guid = z.guid();
const OWNER_NOT_FOUND = 'Not found';
const IMAGE_NOT_FOUND = 'Image not found';

function assertStaff(p: Principal | undefined): void {
  if (p?.orgKind !== 'staff') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
  }
}

const pointerColumn = {
  user_avatar: {
    table: users,
    column: users.avatarDocumentId,
    id: users.id,
    tenant: users.tenantId,
  },
  customer_logo: {
    table: customers,
    column: customers.logoDocumentId,
    id: customers.id,
    tenant: customers.tenantId,
  },
  vendor_logo: {
    table: vendors,
    column: vendors.logoDocumentId,
    id: vendors.id,
    tenant: vendors.tenantId,
  },
} as const;

/** The database store: users, customers and vendors are tenant-wide, so the owner row is found by tenant and id. */
export function drizzleImagePointers(): ImagePointerStore {
  return {
    findDocument: async (tx, scope, documentId) => {
      const [doc] = await tx
        .select({
          id: documents.id,
          ownerType: documents.ownerType,
          ownerId: documents.ownerId,
          organizationId: documents.organizationId,
        })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, scope.tenantId),
            eq(documents.id, documentId),
            isNull(documents.removedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (doc === undefined) return undefined;
      const [newest] = await tx
        .select({ status: documentVersions.status, sha256: documentVersions.sha256 })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.tenantId, scope.tenantId),
            eq(documentVersions.documentId, documentId),
          ),
        )
        .orderBy(desc(documentVersions.version))
        .limit(1);
      // A quarantined version with no sha256 is a failed write (EF3): its bytes never arrived, so it is not usable.
      if (newest === undefined) return { ...doc, status: null };
      const received = newest.status !== 'quarantined' || newest.sha256 !== null;
      return { ...doc, status: received ? newest.status : 'awaiting_content' };
    },
    readPointer: async (tx, scope, ownerType, ownerId) => {
      const p = pointerColumn[ownerType];
      const [row] = await tx
        .select({ documentId: p.column })
        .from(p.table)
        .where(and(eq(p.tenant, scope.tenantId), eq(p.id, ownerId)))
        .limit(1)
        .for('update');
      return row;
    },
    writePointer: async (tx, scope, ownerType, ownerId, documentId) => {
      // One branch per table: drizzle's update() needs the concrete table to type the set().
      if (ownerType === 'user_avatar') {
        await tx
          .update(users)
          .set({ avatarDocumentId: documentId })
          .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, ownerId)));
      } else if (ownerType === 'customer_logo') {
        await tx
          .update(customers)
          .set({ logoDocumentId: documentId })
          .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, ownerId)));
      } else {
        await tx
          .update(vendors)
          .set({ logoDocumentId: documentId })
          .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, ownerId)));
      }
    },
  };
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(IMAGE_POINTER_STORE) private readonly store: ImagePointerStore,
  ) {}

  /** A clean image of the tenant (and entity) for any signed-in staff principal; every refusal is one 404. */
  async open(caller: ImageCaller, documentId: string, ifNoneMatch?: string): Promise<ImageHandle> {
    assertStaff(caller.principal);
    return await this.documents.openImage(caller.scope, documentId, ifNoneMatch);
  }

  /**
   * Makes `body.documentId` the owner's current image, or removes it when null. Returns the pointer after the call.
   * 404: unknown owner type, malformed or unknown owner, or a document that is not a live image of exactly this owner.
   * 403: not staff, or no upload grant on the owner. 409: the image's newest version is not `quarantined` or `clean`
   * (refused, infected, still waiting for its bytes, or its scan failed), checked even when it is already the current
   * one. 400: a bad body.
   */
  async set(
    caller: ImageCaller,
    ownerType: string,
    ownerId: string,
    body: unknown,
  ): Promise<{ documentId: string | null }> {
    assertStaff(caller.principal);
    if (!isImageOwnerType(ownerType) || !Guid.safeParse(ownerId).success) {
      throw new NotFoundException(OWNER_NOT_FOUND);
    }
    // Permission first: someone who may not change the picture learns nothing about the body rules.
    await this.documents.assertCanManage(caller.scope, ownerType, ownerId);
    const parsed = SetImageBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'Body must be exactly {"documentId": <uuid> | null}',
      });
    }
    const next = parsed.data.documentId;
    const { scope } = caller;

    const { result, unclean } = await withTx(this.db, scope, caller.actor, async (tx) => {
      // One lock order for every pointer move: the owner (its row, or the profile setting), then the new document,
      // then the previous one (removePrevious). A concurrent move of the same owner waits at the owner lock, so it
      // can never hold this request's new document (its previous one) while waiting for the owner: no deadlock.
      const current = await this.readCurrent(tx, scope, ownerType, ownerId);
      if (next !== null) await this.assertUsableImage(tx, scope, ownerType, ownerId, next);
      if (current.documentId === next && !current.hasLegacy) {
        return { result: { documentId: next }, unclean: [] };
      }
      await this.writeCurrent(tx, scope, ownerType, ownerId, next, current.profile);
      const removed =
        current.documentId !== null && current.documentId !== next
          ? await this.removePrevious(tx, scope, ownerType, ownerId, current.documentId)
          : [];
      await this.audit.record(tx, {
        action: next === null ? 'image.removed' : 'image.set',
        entityType: ownerType,
        entityId: ownerId,
        meta: { oldDocumentId: current.documentId, newDocumentId: next },
      });
      return { result: { documentId: next }, unclean: removed };
    });
    await this.documents.cleanupRemoved(unclean);
    return result;
  }

  /**
   * Uploads an image and makes it the owner's current one, in one request: the route a caller with the owner's grant
   * (`profile.avatar.write`, `customer.write`, ...) but without `documents.upload` uses. Checks in this order, all
   * before a byte of the body is read: 403 not staff; 404 unknown owner type or malformed owner id; the owner's
   * upload check (404 / 403); 415 a Content-Type outside PNG, JPEG, WebP; 400 a missing or bad `x-file-name`; 413 a
   * Content-Length over the image cap. Then the body is read with a counting cap (413), stored and scanned
   * (DocumentsService.createAndReceiveUpload), and the pointer moves (`set`). If the pointer move fails, the new
   * document is removed (DocumentsService.removeManagedImage, best effort) and that error is thrown.
   */
  async upload(
    ownerType: string,
    ownerId: string,
    req: ImageUploadRequest,
    who: ImageCaller,
  ): Promise<{ documentId: string }> {
    assertStaff(who.principal);
    if (!isImageOwnerType(ownerType) || !Guid.safeParse(ownerId).success) {
      throw new NotFoundException(OWNER_NOT_FOUND);
    }
    await this.documents.assertCanManage(who.scope, ownerType, ownerId);
    const declaredMime = imageMimeOf(req.contentType);
    const filename = fileNameOf(req.fileNameHeader);
    assertDeclaredLength(req.contentLength);
    const bytes = await readCapped(req.stream, IMAGE_MAX_BYTES);
    if (bytes.length === 0) {
      throw new BadRequestException({ code: 'bad_request', message: 'The image is empty' });
    }

    const actorOnly = { scope: who.scope, actor: who.actor };
    const { documentId } = await this.documents.createAndReceiveUpload(
      { ownerType, ownerId },
      { filename, declaredMime, bytes },
      actorOnly,
    );
    if (isEntityLogoOwnerType(ownerType)) {
      await this.recordLogoStats(who, ownerType, documentId, bytes);
    }
    try {
      await this.set(who, ownerType, ownerId, { documentId });
    } catch (error) {
      try {
        // Not `remove`: that is the HTTP path, which refuses a picture.
        await this.documents.removeManagedImage(documentId, { who: actorOnly });
      } catch (cleanup) {
        this.logger.warn(
          `image ${ownerType}/${ownerId}: could not remove ${documentId} after a failed pointer move: ${
            cleanup instanceof Error ? cleanup.message : 'unknown error'
          }`,
        );
      }
      throw error;
    }
    return { documentId };
  }

  /**
   * Measures an uploaded company logo (alpha-weighted luminance, transparency) and keeps the numbers, so a render
   * need not decode it again. Best effort: bytes sharp cannot read are logged and left unmeasured, because the render
   * measures a logo that has no row itself, and the upload must not fail on a cache.
   */
  private async recordLogoStats(
    who: ImageCaller,
    ownerType: EntityLogoOwnerType,
    documentId: string,
    bytes: Buffer,
  ): Promise<void> {
    try {
      const stats = await measureLogo(bytes);
      const { scope } = who;
      await withTx(this.db, scope, who.actor, async (tx) => {
        await tx
          .insert(logoImageStats)
          .values({
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            documentId,
            variant: LOGO_VARIANT[ownerType],
            luminance: stats.luminance,
            hasTransparency: stats.hasTransparency,
          })
          .onConflictDoNothing();
      });
    } catch (error) {
      this.logger.warn(
        `logo ${documentId}: stats not recorded: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }

  /**
   * The new document must be live in the tenant, of exactly this owner, in this entity (a tenant-wide image, see
   * image-scope.ts: a profile picture, customer or vendor logo, may come from any entity of the tenant).
   */
  private async assertUsableImage(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: ImageOwnerType,
    ownerId: string,
    documentId: string,
  ): Promise<void> {
    const doc = await this.store.findDocument(tx, scope, documentId);
    if (
      doc === undefined ||
      doc.ownerType !== ownerType ||
      doc.ownerId !== ownerId ||
      (!isTenantWideImageOwner(ownerType) && doc.organizationId !== scope.organizationId)
    ) {
      throw new NotFoundException(IMAGE_NOT_FOUND);
    }
    if (doc.status !== null && REFUSED_STATUSES.has(doc.status)) {
      throw new ConflictException({
        code: 'conflict',
        message:
          'This image was refused (wrong type or failed the virus scan). Upload another one.',
      });
    }
    if (doc.status === null || !USABLE_STATUSES.has(doc.status)) {
      // Waiting for bytes (an abandoned upload is never scanned) or a scan that failed: never a current picture.
      throw new ConflictException({
        code: 'conflict',
        message:
          'This image is not ready: its upload or virus scan did not finish. Upload it again.',
      });
    }
  }

  private async readCurrent(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: ImageOwnerType,
    ownerId: string,
  ) {
    if (isEntityLogoOwnerType(ownerType)) {
      // Locks the setting key: a concurrent profile save waits, then appends after this one.
      const { value } = await this.settings.getLocked(tx, 'entity.profile');
      return {
        documentId: value[ENTITY_LOGO_FIELD[ownerType]],
        // Only the primary slot replaces the pre-documents logo.
        hasLegacy:
          ownerType === 'entity_logo' &&
          value.legacyLogoDataUrl !== undefined &&
          value.legacyLogoDataUrl !== null,
        profile: value,
      };
    }
    const row = await this.store.readPointer(tx, scope, ownerType, ownerId);
    if (row === undefined) throw new NotFoundException(OWNER_NOT_FOUND);
    return { documentId: row.documentId, hasLegacy: false, profile: undefined };
  }

  private async writeCurrent(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: ImageOwnerType,
    ownerId: string,
    documentId: string | null,
    profile: CompanyProfile | undefined,
  ): Promise<void> {
    if (isEntityLogoOwnerType(ownerType)) {
      // Every other profile field is kept (the other two logo slots too); the pre-documents data-URL logo is
      // replaced (or removed) for good when the primary moves.
      await this.settings.set(tx, 'entity.profile', {
        ...profile,
        [ENTITY_LOGO_FIELD[ownerType]]: documentId,
        ...(ownerType === 'entity_logo' ? { legacyLogoDataUrl: null } : {}),
      });
      return;
    }
    await this.store.writePointer(tx, scope, ownerType, ownerId, documentId);
  }

  /**
   * Soft-removes the image the pointer held. A tenant-wide image (a profile picture, customer or vendor logo) is
   * removed whichever entity of the tenant it was uploaded in; removeInTransaction finds it by tenant. Skipped when
   * that document is already gone, belongs to another owner, or (an entity logo) is outside this entity; the pointer
   * moves either way.
   */
  private async removePrevious(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: ImageOwnerType,
    ownerId: string,
    documentId: string,
  ) {
    const doc = await this.store.findDocument(tx, scope, documentId);
    if (
      doc === undefined ||
      doc.ownerType !== ownerType ||
      doc.ownerId !== ownerId ||
      (!isTenantWideImageOwner(ownerType) && doc.organizationId !== scope.organizationId)
    ) {
      if (doc !== undefined) {
        this.logger.warn(
          `image ${ownerType}/${ownerId}: previous document ${documentId} left in place`,
        );
      }
      return [];
    }
    try {
      return await this.documents.removeInTransaction(tx, scope, documentId);
    } catch (error) {
      // Thrown by its first read, before any write, so the transaction is still usable.
      if (error instanceof NotFoundException) return [];
      throw error;
    }
  }
}
