// The vendor_bill and match_exception approval subjects (P4 unit A1; AD5): what a decision does to its bill, in the
// deciding transaction (ApprovalsService.act), so the decision and its effects commit or roll back together.
// match_exception (document id = the exception id):
// - approved: the exception names its decider; the bill (still exception_pending) gets match_status
//   exception_approved, so submit lets it through;
// - returned or rejected: the exception is rejected and the bill goes back to variance (a new exception or a corrected
//   match may follow). BILL_TRANSITIONS has no exception_pending → variance move; the bill cannot stay blocked in
//   exception_pending with nothing pending, so this subject makes that move.
// vendor_bill (document id = the bill id):
// - returned: back to draft (match again before a new submit); rejected: rejected;
// - approved: the payable open item and `vendor_bill_posted` are the next unit. Until it lands, an approval is
//   refused (409) and rolls back, so no bill is ever approved without its open item.
// A bill or exception that is not waiting for this decision is refused (409), never silently skipped.
import { matchExceptions, scoped, vendorBills } from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { DbTransaction } from '../../../platform/db/db.module';
import { actorUuid, readTxContext } from '../../../platform/documents/tx-context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import {
  BILL_AUDIT_ENTITY,
  MATCH_EXCEPTION_AUDIT_ENTITY,
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  VENDOR_BILL_DOCUMENT_TYPE,
} from './vendor-bill.rules';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (code: string, message: string) => new ConflictException({ code, message });

export class VendorBillSubject implements ApprovalSubject {
  readonly documentType = VENDOR_BILL_DOCUMENT_TYPE;
  private readonly log = new Logger(VendorBillSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async onDecided(tx: DbTransaction, billId: string, outcome: Outcome): Promise<void> {
    const { scope } = await readTxContext(tx);
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, billId)))
      .for('update');
    if (bill === undefined) throw conflict('not_found', 'The bill was not found');
    if (bill.status !== 'pending_approval') {
      this.log.error(`bill ${bill.id} is ${bill.status}; refusing outcome ${outcome}`);
      throw conflict('invalid_transition', 'The bill is not waiting for an approval decision');
    }
    if (outcome === 'approved') {
      throw conflict(
        'BILL_POSTING_UNAVAILABLE',
        'Approving a bill opens its payable, which is not available yet',
      );
    }
    const status = outcome === 'returned' ? 'draft' : 'rejected';
    await tx
      .update(vendorBills)
      .set({ status, version: sql`${vendorBills.version} + 1`, updatedAt: this.clock() })
      .where(
        scoped(scope).where(
          vendorBills,
          and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'pending_approval')),
        ),
      );
    await this.audit.record(tx, {
      action: `payables.bill.${outcome}`,
      entityType: BILL_AUDIT_ENTITY,
      entityId: bill.id,
      before: { status: bill.status },
      after: { status },
    });
  }
}

export class MatchExceptionSubject implements ApprovalSubject {
  readonly documentType = MATCH_EXCEPTION_DOCUMENT_TYPE;
  private readonly log = new Logger(MatchExceptionSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async onDecided(tx: DbTransaction, exceptionId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const now = this.clock();
    const deciderId = actorUuid(ctx);
    if (deciderId === null) throw new Error('a match exception is decided by a user');
    const [exception] = await tx
      .select()
      .from(matchExceptions)
      .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, exceptionId)))
      .for('update');
    if (exception === undefined) throw conflict('not_found', 'The match exception was not found');
    if (exception.status !== 'pending') {
      this.log.error(`exception ${exception.id} is ${exception.status}; refusing ${outcome}`);
      throw conflict('invalid_transition', 'The match exception is not waiting for a decision');
    }
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, exception.vendorBillId)))
      .for('update');
    if (bill?.status !== 'exception_pending') {
      throw conflict('invalid_transition', 'The bill is not waiting for a match exception');
    }
    const approved = outcome === 'approved';
    await tx
      .update(matchExceptions)
      .set({
        status: approved ? 'approved' : 'rejected',
        decidedBy: deciderId,
        decidedAt: now,
        version: sql`${matchExceptions.version} + 1`,
        updatedAt: now,
      })
      .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, exception.id)));
    const next = approved
      ? { status: 'exception_pending' as const, matchStatus: 'exception_approved' as const }
      : { status: 'variance' as const, matchStatus: 'variance' as const };
    await tx
      .update(vendorBills)
      .set({ ...next, version: sql`${vendorBills.version} + 1`, updatedAt: now })
      .where(
        scoped(scope).where(
          vendorBills,
          and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'exception_pending')),
        ),
      );
    await this.audit.record(tx, {
      action: `payables.match_exception.${approved ? 'approved' : 'rejected'}`,
      entityType: MATCH_EXCEPTION_AUDIT_ENTITY,
      entityId: exception.id,
      before: { status: 'pending', bill: { status: bill.status, matchStatus: bill.matchStatus } },
      after: { status: approved ? 'approved' : 'rejected', bill: next, outcome },
    });
  }
}
