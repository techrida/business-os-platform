// The quotation_version approval subject (Q2): what a decided approval does to the version it was about.
// Serves the NFR "approvals are auditable" and "what was approved is what was seen": before the outcome is
// recorded, the material fields are rebuilt from the rows and hashed again, and a version whose hash no longer
// matches the one stored at submit is refused (M10), which rolls the decision back. Nothing slow runs here (M3):
// an approved version keeps render_state 'none' and the render worker draws its PDF: since round 5 (S3) at once,
// through the job afterDecided enqueues when the approval commits, with the sweep as the safety net.
// Registered by QuotationsModule in the API only. ApprovalsService.act is an API route, so the worker never
// calls onDecided.
import type { ApprovalContext } from '@bos/contracts';
import {
  customers,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { actorUuid, readTxContext } from '../../../platform/documents/tx-context';
import { fact, hrefIfVisible } from '../../approvals/context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import type { QuotationRenderNudge } from '../render/quotation-render.nudge';
import { contentSha256, materialFieldsOf } from './quotation-approval-snapshot';

/** approval_requests.document_type of a quotation version; the document id is the version id. */
export const QUOTATION_VERSION_DOCUMENT_TYPE = 'quotation_version';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/**
 * The workspace page of the quotation that owns `versionId` (`/quotations/<quotationId>`), or undefined when the
 * acting entity has no such version (the requester then gets the inbox link). The subject's `link` hook.
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

  constructor(
    private readonly clock: () => Date = () => new Date(),
    /** Renders an approved version's PDF once the approval commits; absent, the render sweep draws it. */
    private readonly renderNudge?: QuotationRenderNudge,
  ) {}

  /** After an approval commits: the version is rendered now rather than on the next sweep. */
  async afterDecided(decided: {
    scope: TxScope;
    documentId: string;
    outcome: Outcome;
  }): Promise<void> {
    if (decided.outcome !== 'approved') return;
    await this.renderNudge?.nudge(decided.scope, decided.documentId);
  }

  /** The decided notice opens the quotation, not the request in the inbox. */
  readonly link = (tx: DbTransaction, versionId: string): Promise<string | undefined> =>
    quotationLinkOf(tx, versionId);

  /**
   * The version as it stands now. Its PDF is drawn only after approval, so there is no file to list. The quotation
   * page is linked only when the reader's `quotation.read` scope reaches the quotation, as its own routes decide.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [row] = await q
      .select({
        quotationId: quotations.id,
        number: quotations.number,
        revisionNo: quotationVersions.revisionNo,
        customerName: customers.legalName,
        validUntil: quotationVersions.validUntil,
        currency: quotationVersions.currency,
        total: quotationVersions.total,
        status: quotationVersions.status,
      })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.organizationId, quotationVersions.organizationId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .leftJoin(
        customers,
        and(
          eq(customers.tenantId, quotations.tenantId),
          eq(customers.id, quotations.customerPartyId),
        ),
      )
      .where(scoped(scope).where(quotationVersions, eq(quotationVersions.id, request.documentId)));
    if (row === undefined) return null;
    return {
      title: `Quotation ${row.number}`,
      fields: [
        ...fact.text('revision', 'Revision', String(row.revisionNo)),
        ...fact.text('customer', 'Customer', row.customerName),
        ...fact.date('validUntil', 'Valid until', row.validUntil),
        ...fact.money('total', 'Total', row.total, row.currency),
        ...fact.status(row.status),
      ],
      documents: [],
      href: await hrefIfVisible(
        q,
        viewer,
        quotations,
        'quotation.read',
        row.quotationId,
        `/quotations/${row.quotationId}`,
      ),
    };
  }

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

  /** A cancel is the quotation module's own act (revise or cancel), which sets the version's status itself. */
  onCancelled(_tx: DbTransaction, _versionId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
