// The `evidence` document owner type (round 5 P2): a file uploaded in place as the evidence of one record (a sales
// order's milestone, a vendor bill's match exception, an RFQ's vendor quotation), with owner id = that record's id.
// The owner policy that resolves the record lives in modules/evidence; this file holds what every record that
// takes evidence checks before it stores the reference, so the modules do not import each other.
// Serves the NFR "deny by default": a record accepts only evidence uploaded to itself in its own entity, never a
// picture (logo, avatar), a payment proof, a vendor-inbox file or a file of another record, even of the same entity.
import { documents, documentVersions, scoped } from '@bos/db';
import { UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { assertNotInfected, newestNonRejected } from './documents.service';

export const EVIDENCE_OWNER_TYPE = 'evidence';

const Id = z.guid();

/**
 * 422 `invalid_evidence_document`: the id is not a live evidence file of this record in this entity (missing,
 * removed, of another entity or record, or another kind of file). One answer for each, so nothing is learned
 * about files the record does not own.
 */
export function invalidEvidenceDocument(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'invalid_evidence_document',
    message:
      'This file is not evidence uploaded to this record. Upload the evidence here, then try again.',
  });
}

/**
 * 422 `invalid_evidence_document`: the record's own evidence file holds no bytes yet (reserved but never sent, an
 * empty later version, or every version rejected). A record that takes it freezes it, so it would stay empty.
 */
export function evidenceNotUploaded(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'invalid_evidence_document',
    message: 'This evidence file has not finished uploading. Upload it again, then try again.',
  });
}

/**
 * Passes when `documentId` is a live document of this scope that is evidence of `ownerId` (owner type `evidence`),
 * or is one of `alsoAccept` (ids the record already recorded as its evidence, of an older owner type) and still
 * live. A list entry of owner type `evidence` counts only when it is evidence of `ownerId`: a file uploaded as the
 * evidence of another record stays that record's own, whatever a list names.
 * Otherwise 422 `invalid_evidence_document`; then 409 `document_infected` when its newest version is infected
 * (TR-Q12e). The record's own evidence must also hold its bytes: its newest version that was not rejected is
 * `quarantined` with its bytes recorded (still scanning, each later step keeps its own clean-file rule) or `clean`;
 * anything else (no such version, awaiting_content, scan_failed, a `quarantined` version still receiving its bytes) is
 * 422, because the record freezes the file it takes. An `alsoAccept` file
 * was filed by the record earlier under its own checks and is not asked again. Run it in the transaction that writes
 * the reference.
 */
export async function assertEvidenceDocument(
  reader: Pick<Db, 'select'>,
  scope: TxScope,
  documentId: string,
  ownerId: string,
  alsoAccept: readonly string[] = [],
): Promise<void> {
  if (!Id.safeParse(documentId).success || !Id.safeParse(ownerId).success) {
    throw invalidEvidenceDocument();
  }
  const accepted = alsoAccept.filter((id) => Id.safeParse(id).success);
  const ownEvidence = and(
    eq(documents.ownerType, EVIDENCE_OWNER_TYPE),
    eq(documents.ownerId, ownerId),
  );
  const [found] = await reader
    .select({ ownerType: documents.ownerType, ownerId: documents.ownerId })
    .from(documents)
    .where(
      scoped(scope).where(
        documents,
        and(
          eq(documents.id, documentId),
          isNull(documents.removedAt),
          accepted.length === 0
            ? ownEvidence
            : or(
                ownEvidence,
                and(inArray(documents.id, accepted), ne(documents.ownerType, EVIDENCE_OWNER_TYPE)),
              ),
        ),
      ),
    )
    .limit(1);
  if (found === undefined) throw invalidEvidenceDocument();
  await assertNotInfected(reader, scope, [documentId]);
  if (found.ownerType !== EVIDENCE_OWNER_TYPE || found.ownerId !== ownerId) return;
  await assertHoldsBytes(reader, scope, documentId);
}

/**
 * For a record that files documents of any older owner type as its evidence (a sales order's confirm): every id of
 * owner type `evidence` must be evidence of `ownerId` (none when the record does not exist yet) and hold its bytes,
 * as `assertEvidenceDocument` asks. Otherwise 422 `invalid_evidence_document`. Other owner types pass untouched;
 * the caller checks them as before.
 */
export async function assertNoForeignEvidence(
  reader: Pick<Db, 'select'>,
  scope: TxScope,
  documentIds: readonly string[],
  ownerId: string | null,
): Promise<void> {
  const ids = documentIds.filter((id) => Id.safeParse(id).success);
  if (ids.length === 0) return;
  const rows = await reader
    .select({ id: documents.id, ownerId: documents.ownerId })
    .from(documents)
    .where(
      scoped(scope).where(
        documents,
        and(inArray(documents.id, ids), eq(documents.ownerType, EVIDENCE_OWNER_TYPE)),
      ),
    );
  if (rows.some((r) => r.ownerId !== ownerId)) throw invalidEvidenceDocument();
  for (const row of rows) await assertHoldsBytes(reader, scope, row.id);
}

/**
 * The newest version that was not rejected is `clean`, or `quarantined` with its bytes recorded, else 422 (see
 * `evidenceNotUploaded`). The receive claims the version (`quarantined`) in its first transaction, before the bytes are
 * stored, and records their sha256 only once they are durable and type-checked (step 4 of `receiveInternal`); sha256 is
 * the receipt-complete marker (a stored hash never changes, document_versions_guard_update). A save in between would
 * freeze the file with no bytes behind it.
 */
async function assertHoldsBytes(
  reader: Pick<Db, 'select'>,
  scope: TxScope,
  documentId: string,
): Promise<void> {
  const versions = await reader
    .select({
      version: documentVersions.version,
      status: documentVersions.status,
      sha256: documentVersions.sha256,
    })
    .from(documentVersions)
    .where(scoped(scope).where(documentVersions, eq(documentVersions.documentId, documentId)));
  const newest = newestNonRejected(versions);
  const received =
    newest?.status === 'clean' || (newest?.status === 'quarantined' && newest.sha256 !== null);
  if (!received) throw evidenceNotUploaded();
}
