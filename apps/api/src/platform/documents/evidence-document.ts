// The `evidence` document owner type (round 5 P2): a file uploaded in place as the evidence of one record (a sales
// order's milestone, a vendor bill's match exception, an RFQ's vendor quotation), with owner id = that record's id.
// The owner policy that resolves the record lives in modules/evidence; this file holds what every record that
// takes evidence checks before it stores the reference, so the modules do not import each other.
// Serves the NFR "deny by default": a record accepts only evidence uploaded to itself in its own entity, never a
// picture (logo, avatar), a payment proof, a vendor-inbox file or a file of another record, even of the same entity.
import { documents, scoped } from '@bos/db';
import { UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { assertNotInfected } from './documents.service';

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
 * Passes when `documentId` is a live document of this scope that is evidence of `ownerId` (owner type `evidence`),
 * or is one of `alsoAccept` (ids the record already recorded as its evidence, any owner type) and still live.
 * Otherwise 422 `invalid_evidence_document`; then 409 `document_infected` when its newest version is infected
 * (TR-Q12e). A file still scanning passes, as before: each later step keeps its own clean-file rule. Run it in the
 * transaction that writes the reference.
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
    .select({ id: documents.id })
    .from(documents)
    .where(
      scoped(scope).where(
        documents,
        and(
          eq(documents.id, documentId),
          isNull(documents.removedAt),
          accepted.length === 0 ? ownEvidence : or(ownEvidence, inArray(documents.id, accepted)),
        ),
      ),
    )
    .limit(1);
  if (found === undefined) throw invalidEvidenceDocument();
  await assertNotInfected(reader, scope, [documentId]);
}
