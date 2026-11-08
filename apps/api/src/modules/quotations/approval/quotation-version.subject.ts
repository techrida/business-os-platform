// The quotation_version approval subject (Q2): what a decided approval does to the version it was about.
// Serves the NFR "approvals are auditable" and "what was approved is what was seen": before the outcome is
// recorded, the material fields are rebuilt from the rows and hashed again, and a version whose hash no longer
// matches the one stored at submit is refused (M10), which rolls the decision back. Nothing slow runs here (M3):
// an approved version keeps render_state 'none' and the render sweeper (worker) draws its PDF.
// Registered by QuotationsModule in the API only. ApprovalsService.act is an API route, so the worker never
// calls onDecided.
import {
  quotationLines,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { DbTransaction } from '../../../platform/db/db.module';
import { actorUuid, readTxContext } from '../../../platform/documents/tx-context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { contentSha256, materialFieldsOf } from './quotation-approval-snapshot';

/** approval_requests.document_type of a quotation version; the document id is the version id. */
export const QUOTATION_VERSION_DOCUMENT_TYPE = 'quotation_version';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/**
 * The workspace page of the quotation that owns `versionId` (`/quotations/<quotationId>`), or undefined when the
 * acting entity has no such version. Async because it reads the version. ApprovalSubject.link is synchronous and
 * gets no transaction, so this is not registered as `link` yet; see the hand-back for the kernel change.
 */
export async function quotationLinkOf(
  tx: DbTransaction,
  versionId: string,
): Promise<string | undefined> {
  const { scope } = await readTxContext(tx);
  const [row] = await tx
    .select({ quotationId: quotationVersions.quotationId })
    .from(quotationVersions)
    .where(scoped(scope).where(quotationVersions, eq(quotationVersions.id, versionId)));
  return row === undefined ? undefined : `/quotations/${row.quotationId}`;
}

/**
 * onDecided runs in the deciding transaction (ApprovalsService.act), so the version's new status commits or
 * rolls back with the decision. The scope and the actor come from the transaction's bos.* settings.
 */
export class QuotationVersionSubject implements ApprovalSubject {
  readonly documentType = QUOTATION_VERSION_DOCUMENT_TYPE;
  private readonly log = new Logger(QuotationVersionSubject.name);

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async onDecided(tx: DbTransaction, versionId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const [version] = await tx
      .select()
      .from(quotationVersions)
      .where(scoped(scope).where(quotationVersions, eq(quotationVersions.id, versionId)))
      .for('update');
    // Throwing rolls the decision back. A decided request whose version is missing or not submitted means the
    // two tables disagree, and a silent skip would leave the version's status wrong forever.
    if (version === undefined) {
      this.log.error(`quotation version ${versionId} not found; refusing outcome ${outcome}`);
      throw conflict('The quotation version is not waiting for a decision');
    }
    if (version.status !== 'submitted') {
      this.log.error(
        `quotation version ${versionId} is ${version.status}, not submitted; refusing outcome ${outcome}`,
      );
      throw conflict('The quotation version is not waiting for a decision');
    }

    const lines = await tx
      .select()
      .from(quotationLines)
      .where(scoped(scope).where(quotationLines, eq(quotationLines.versionId, versionId)));
    const taxSummary = await tx
      .select()
      .from(quotationTaxSummary)
      .where(
        scoped(scope).where(quotationTaxSummary, eq(quotationTaxSummary.versionId, versionId)),
      );
    const actual = contentSha256(materialFieldsOf(version, lines, taxSummary));
    const stored = version.contentSha256;
    if (stored === null || !Buffer.from(stored).equals(actual)) {
      this.log.error(
        `quotation version ${versionId} no longer matches its content hash; refusing outcome ${outcome}`,
      );
      throw conflict('The quotation version changed after it was submitted');
    }

    const now = this.clock();
    const updated = await tx
      .update(quotationVersions)
      .set({
        status: outcome,
        ...(outcome === 'approved' ? { approvedAt: now } : {}),
        ...(outcome === 'rejected'
          ? { rejectionSource: 'internal' as const, rejectedAt: now }
          : {}),
        version: sql`${quotationVersions.version} + 1`,
        updatedAt: now,
      })
      .where(
        scoped(scope).where(
          quotationVersions,
          and(eq(quotationVersions.id, versionId), eq(quotationVersions.status, 'submitted')),
        ),
      )
      .returning({ id: quotationVersions.id });
    if (updated.length === 0) throw conflict('The quotation version is not waiting for a decision');

    await tx.insert(quotationStatusHistory).values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      versionId,
      fromStatus: 'submitted',
      toStatus: outcome,
      actorId: actorUuid(ctx),
      at: now,
    });
  }

  /** A cancel is the quotation module's own act (revise or withdraw), which sets the version's status itself. */
  onCancelled(_tx: DbTransaction, _versionId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
