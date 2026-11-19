// Which image is current (U12, D33): serving an image to staff, and moving an owner's pointer to a new image.
// Images are documents (image-owner.policies.ts); the "current" one is a pointer on the owner:
//   entity_logo   -> setting `entity.profile`.logoDocumentId (versioned through SettingsService, so history is kept)
//   user_avatar   -> app.users.avatar_document_id
//   customer_logo -> app.customers.logo_document_id
//   vendor_logo   -> app.vendors.logo_document_id
// Serves the NFRs:
// - "deny by default": only staff read or write here; changing a pointer needs the owner type's upload grant on the
//   owner's ref (DocumentsService.assertCanManage, the check uploads use: 404 for an owner outside the scope, 403
//   without the grant), and the new document must be a live image of exactly that owner (404 otherwise);
// - "every change is audited and nothing is lost": the pointer moves, the previous image is soft-removed
//   (DocumentsService.removeInTransaction) and `image.set` / `image.removed` is recorded, all in one transaction.
import {
  isImageOwnerType,
  SetImageBodySchema,
  type CompanyProfile,
  type ImageOwnerType,
} from '@bos/contracts';
import { customers, documents, documentVersions, users, vendors } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { DocumentsService, type ImageHandle } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';

/** The pointer owners that are rows (the entity logo is a setting). */
export type RowImageOwnerType = Exclude<ImageOwnerType, 'entity_logo'>;

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

/** Version states that can never become a picture: the bytes were refused or carry a virus. */
const UNUSABLE_STATUSES: ReadonlySet<string> = new Set(['rejected', 'infected']);
/** People belong to the tenant, not one entity: a profile picture may have been uploaded in any entity. */
const TENANT_WIDE_OWNER: ImageOwnerType = 'user_avatar';
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
        .select({ status: documentVersions.status })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.tenantId, scope.tenantId),
            eq(documentVersions.documentId, documentId),
          ),
        )
        .orderBy(desc(documentVersions.version))
        .limit(1);
      return { ...doc, status: newest?.status ?? null };
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
   * 403: not staff, or no upload grant on the owner. 409: the image was rejected or is infected. 400: a bad body.
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
      if (next !== null) await this.assertUsableImage(tx, scope, ownerType, ownerId, next);
      const current = await this.readCurrent(tx, scope, ownerType, ownerId);
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

  /** The new document must be live in the tenant, of exactly this owner, in this entity (an avatar: any entity). */
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
      (ownerType !== TENANT_WIDE_OWNER && doc.organizationId !== scope.organizationId)
    ) {
      throw new NotFoundException(IMAGE_NOT_FOUND);
    }
    if (doc.status === null || UNUSABLE_STATUSES.has(doc.status)) {
      throw new ConflictException({
        code: 'conflict',
        message:
          'This image was refused (wrong type or failed the virus scan). Upload another one.',
      });
    }
  }

  private async readCurrent(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: ImageOwnerType,
    ownerId: string,
  ) {
    if (ownerType === 'entity_logo') {
      // Locks the setting key: a concurrent profile save waits, then appends after this one.
      const { value } = await this.settings.getLocked(tx, 'entity.profile');
      return {
        documentId: value.logoDocumentId,
        hasLegacy: value.legacyLogoDataUrl !== undefined && value.legacyLogoDataUrl !== null,
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
    if (ownerType === 'entity_logo') {
      // Every other profile field is kept; the pre-documents data-URL logo is replaced (or removed) for good.
      await this.settings.set(tx, 'entity.profile', {
        ...profile,
        logoDocumentId: documentId,
        legacyLogoDataUrl: null,
      });
      return;
    }
    await this.store.writePointer(tx, scope, ownerType, ownerId, documentId);
  }

  /**
   * Soft-removes the image the pointer held. Skipped when that document is already gone, belongs to another owner,
   * or (a profile picture uploaded while acting for another entity) is outside this entity, where
   * removeInTransaction cannot reach it; the pointer moves either way.
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
      doc.organizationId !== scope.organizationId
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
