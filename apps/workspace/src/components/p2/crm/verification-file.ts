// The file behind one checklist item, as the case page shows it. Pure (no server-only import), so
// the parse of `GET /v1/documents/:id` and the choice of version can be tested on their own.

import { DocumentVersionDtoSchema, type DocumentVersionDto } from '@bos/contracts';
import { z } from 'zod';

/**
 * What `GET /v1/documents/:id` answers (DocumentsService.get). The contracts have no schema for it,
 * so this reads only what the case page needs; extra fields are ignored.
 */
export const DocumentSchema = z.object({
  id: z.guid(),
  ownerType: z.string(),
  ownerId: z.guid(),
  currentVersionId: z.guid().nullable(),
  versions: z.array(DocumentVersionDtoSchema),
});
export type DocumentDetail = z.infer<typeof DocumentSchema>;

export interface FileView {
  documentId: string;
  versionId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  /** Only clean versions can be previewed or downloaded. Both routes enforce this. */
  status: DocumentVersionDto['status'];
}

export function projectVersion(v: DocumentVersionDto): FileView {
  return {
    documentId: v.documentId,
    versionId: v.id,
    filename: v.filename,
    sizeBytes: v.sizeBytes,
    mimeType: v.detectedMime ?? v.declaredMime,
    status: v.status,
  };
}

/** The newest non-rejected version is also the evidence used for approval. */
export function fileOf(doc: DocumentDetail): FileView | null {
  const versions = [...doc.versions].sort((a, b) => b.version - a.version);
  const version = versions.find((v) => v.status !== 'rejected') ?? versions[0];
  return version === undefined ? null : projectVersion(version);
}

function versionHref(file: Pick<FileView, 'documentId' | 'versionId'>): string {
  return `/api/documents/${encodeURIComponent(file.documentId)}/versions/${encodeURIComponent(file.versionId)}`;
}

export function previewHref(file: Pick<FileView, 'documentId' | 'versionId'>): string {
  return `${versionHref(file)}/preview`;
}

export function downloadHref(file: Pick<FileView, 'documentId' | 'versionId'>): string {
  return `${versionHref(file)}/download`;
}
