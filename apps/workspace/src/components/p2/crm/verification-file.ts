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
  currentVersionId: z.guid().nullable(),
  versions: z.array(DocumentVersionDtoSchema),
});
export type DocumentDetail = z.infer<typeof DocumentSchema>;

export interface FileView {
  documentId: string;
  versionId: string;
  filename: string;
  sizeBytes: number;
  /** The scan status; only `clean` may be opened, and the download route checks it again. */
  status: DocumentVersionDto['status'];
}

/**
 * The version a reviewer should open: the document's current version, or when the API names none
 * the newest one that was not rejected. Null when the document has no usable version.
 */
export function fileOf(doc: DocumentDetail, boundVersionId?: string): FileView | null {
  const current = boundVersionId
    ? doc.versions.find((v) => v.id === boundVersionId)
    : (doc.versions.find((v) => v.id === doc.currentVersionId) ??
      doc.versions.filter((v) => v.status !== 'rejected').sort((a, b) => b.version - a.version)[0]);
  if (current === undefined) return null;
  return {
    documentId: doc.id,
    versionId: current.id,
    filename: current.filename,
    sizeBytes: current.sizeBytes,
    status: current.status,
  };
}

/** The same-origin route that streams a clean file (it issues the signed link when clicked). */
export function downloadHref(file: Pick<FileView, 'documentId' | 'versionId'>): string {
  return `/api/documents/${encodeURIComponent(file.documentId)}/versions/${encodeURIComponent(file.versionId)}/download`;
}
