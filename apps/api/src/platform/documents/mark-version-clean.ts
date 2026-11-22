// The one place a quarantined version becomes `clean`. Used by the scan processor (clamd said clean) and by
// DocumentsService.receiveGenerated (D28: PDFs the system renders itself skip the scan), so both paths set the
// same columns, move the document's current_version_id the same way and write the same audit event.
import { documents, documentVersions, scoped } from '@bos/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import type { DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import type { AuditPort } from './documents.ports';

type VersionRow = typeof documentVersions.$inferSelect;

/** The `scan_engine` value (and audit engine) of a version that skipped the scan because the system made it (D28). */
export const GENERATED_ENGINE = 'generated';

/** Every verdict update carries this: it only applies to a version that is still waiting for its scan. */
export function stillQuarantined(versionId: string) {
  return and(eq(documentVersions.id, versionId), eq(documentVersions.status, 'quarantined'));
}

/**
 * Marks a still-quarantined version `clean` and returns the updated row, or null when it is not quarantined any
 * more (another run finished it, it was rejected or moved on): nothing is written then, the document is not
 * repointed and no audit event is recorded, so a retry never audits twice.
 *
 * `how.engine` goes into `scan_engine` and the audit event; `how.result` is the audit event's result label
 * ('clean' for a clamd verdict, 'generated' for a system-rendered file). The sha256 is left as it is.
 * The document points at its newest clean version: set when it has none, or only an older one.
 */
export async function markVersionClean(
  tx: DbTransaction,
  audit: AuditPort,
  scope: TxScope,
  v: Pick<VersionRow, 'id' | 'documentId' | 'version' | 'sha256'>,
  how: { result: string; engine: string },
): Promise<VersionRow | null> {
  const s = scoped(scope);
  const [updated] = await tx
    .update(documentVersions)
    .set({
      status: 'clean',
      scanSignature: null,
      scanEngine: how.engine,
      scannedAt: new Date(),
      updatedAt: new Date(),
    })
    // Only an upload that recorded its validation (sha256 and detected type) can be published as clean.
    .where(
      s.where(
        documentVersions,
        and(
          stillQuarantined(v.id),
          isNotNull(documentVersions.sha256),
          isNotNull(documentVersions.detectedMime),
        ),
      ),
    )
    .returning();
  // Zero rows: the version moved on since the caller read it. Do not point the document at it or audit a scan.
  if (updated === undefined) return null;
  await tx
    .update(documents)
    .set({ currentVersionId: v.id, updatedAt: new Date() })
    .where(
      s.where(
        documents,
        and(
          eq(documents.id, v.documentId),
          sql`(${documents.currentVersionId} IS NULL OR EXISTS (
                SELECT 1 FROM ${documentVersions} c
                 WHERE c.id = ${documents.currentVersionId} AND c.version < ${v.version}))`,
        ),
      ),
    );
  await audit.record(tx, {
    action: 'document.scanned',
    entityType: 'document_version',
    entityId: v.id,
    meta: { result: how.result, engine: how.engine, sha256: v.sha256?.toString('hex') ?? null },
  });
  return updated;
}
