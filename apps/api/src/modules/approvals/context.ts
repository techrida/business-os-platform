// Helpers for an approval subject's `context` (U18 #2): a read-only view of the record an approval is about, served to
// whoever may read the approval request, so an approver judges the record without a read grant on it. Two rules keep it
// from leaking or dead-ending:
// - a file is listed only when the reader could open it through the documents routes: its owner's own policy
//   (`resource`) and `documents.read` on that ref, exactly as DocumentsService.assertOwner decides, and only when its
//   newest version is clean (anything else answers 409 on the link);
// - the record's page is linked only when the reader holds the permission that page's API asks for.
import type { ApprovalContextDocument, ApprovalContextField, Permission } from '@bos/contracts';
import { documents, documentVersions, scoped } from '@bos/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import { can, type ResourceRef } from '../../platform/authz/can';
import type { Principal, ScopableTable } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';

/** Whether `viewer`, a staff member, holds `permission` on `ref` (or at all, without one). */
export function mayOpen(viewer: Principal, permission: Permission, ref?: ResourceRef): boolean {
  return viewer.orgKind === 'staff' && can(viewer, permission, ref).allowed;
}

/** `href` when `viewer` may open it, else null. */
export function hrefFor(
  viewer: Principal,
  href: string,
  permission: Permission,
  ref?: ResourceRef,
): string | null {
  return mayOpen(viewer, permission, ref) ? href : null;
}

/**
 * `href` when `viewer` may read row `id` of `table` under `permission`, decided in SQL with the same `scopeWhereFor`
 * rule the record's own read routes use (own, department or all), else null.
 */
export async function hrefIfVisible(
  q: Db,
  viewer: Principal,
  table: ScopableTable & { id: AnyPgColumn },
  permission: Permission,
  id: string,
  href: string,
): Promise<string | null> {
  if (viewer.orgKind !== 'staff') return null;
  const [row] = await q
    .select({ id: table.id })
    .from(table)
    .where(and(scopeWhereFor(viewer, table, permission), eq(table.id, id)))
    .limit(1);
  return row === undefined ? null : href;
}

type Owner = Pick<DocumentOwnerPolicy, 'ownerType' | 'resource' | 'readPermission'>;

/**
 * The given documents that `viewer` may read, newest version each, in the order asked. A document of an owner type
 * none of `owners` handles is left out (deny by default), as is a removed one or one whose newest version is not clean.
 */
export async function readableDocuments(
  q: Db,
  scope: TxScope,
  viewer: Principal,
  documentIds: readonly (string | null | undefined)[],
  owners: readonly Owner[],
): Promise<ApprovalContextDocument[]> {
  const ids = [...new Set(documentIds.filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0 || viewer.orgKind !== 'staff') return [];
  const docs = await q
    .select({ id: documents.id, ownerType: documents.ownerType, ownerId: documents.ownerId })
    .from(documents)
    .where(
      scoped(scope).where(documents, and(inArray(documents.id, ids), isNull(documents.removedAt))),
    );
  const out: ApprovalContextDocument[] = [];
  for (const id of ids) {
    const doc = docs.find((d) => d.id === id);
    const owner = owners.find((o) => o.ownerType === doc?.ownerType);
    if (doc === undefined || owner === undefined) continue;
    const ref = await owner.resource(scope, doc.ownerId);
    if (ref === null) continue;
    // The same test DocumentsService makes: documents.read, or the owner policy's own extra read permission.
    const mayOpen = ['documents.read' as Permission, owner.readPermission].some(
      (p) => p !== undefined && can(viewer, p, ref).allowed,
    );
    if (!mayOpen) continue;
    const [newest] = await q
      .select({
        id: documentVersions.id,
        filename: documentVersions.filename,
        detectedMime: documentVersions.detectedMime,
        status: documentVersions.status,
        sizeBytes: documentVersions.sizeBytes,
        uploadedBy: documentVersions.uploadedBy,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(scoped(scope).where(documentVersions, eq(documentVersions.documentId, id)))
      .orderBy(desc(documentVersions.version))
      .limit(1);
    if (newest?.status !== 'clean') continue;
    out.push({
      documentId: id,
      versionId: newest.id,
      filename: newest.filename,
      detectedMime: newest.detectedMime,
      sizeBytes: newest.sizeBytes,
      uploadedBy: newest.uploadedBy,
      uploadedAt: newest.createdAt.toISOString(),
    });
  }
  return out;
}

/** Field builders, so each subject lists its facts in one line each. Empty values are left out. */
export const fact = {
  text: (key: string, label: string, value: string | null | undefined): ApprovalContextField[] =>
    value === null || value === undefined || value.trim() === ''
      ? []
      : [{ key, label, value, kind: 'text' }],
  money: (
    key: string,
    label: string,
    value: string | null | undefined,
    currency: string,
  ): ApprovalContextField[] =>
    value === null || value === undefined ? [] : [{ key, label, value, kind: 'money', currency }],
  date: (
    key: string,
    label: string,
    value: string | Date | null | undefined,
  ): ApprovalContextField[] =>
    value === null || value === undefined
      ? []
      : [
          {
            key,
            label,
            value: value instanceof Date ? value.toISOString() : value,
            kind: 'date',
          },
        ],
  status: (value: string, key = 'status', label = 'Status'): ApprovalContextField[] => [
    { key, label, value, kind: 'status' },
  ],
};
