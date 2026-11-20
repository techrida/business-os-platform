// Moving the open follow-ups of a lead or opportunity with its owner (D45). One rule for both record kinds, so a
// lead's owner change, an opportunity's owner change (F1-Q51) and any later caller move the same rows the same way.
import { activities, scoped } from '@bos/db';
import { and, eq, sql } from 'drizzle-orm';

import type { AuditService } from '../../platform/audit/audit.service';
import type { DbTransaction, TxScope } from '../../platform/db/tx';
import { isPlannedSql } from './activities.types';

/** The record whose follow-ups move, and why (the audit meta names it). */
export interface FollowUpOwnerChange {
  subject: 'leadId' | 'opportunityId';
  subjectId: string;
  from: string | null;
  to: string;
  reason: 'lead_owner_changed' | 'opportunity_owner_changed';
}

/**
 * D45: follow-ups follow the owner. The record's open planned activities assigned to the old owner move to the new
 * one, in the owner change's own transaction, one audit row each (`activity.reassigned`). Follow-ups assigned to
 * anyone else (or to no one), and completed or cancelled ones, stay as they are. The version moves with the
 * assignee, so a form open on the old assignee gets a 409 instead of silently putting it back. Returns the ids moved.
 */
export async function moveOpenFollowUps(
  tx: DbTransaction,
  scope: TxScope,
  audit: AuditService,
  change: FollowUpOwnerChange,
): Promise<string[]> {
  const { subject, subjectId, from, to, reason } = change;
  if (from === null || from === to) return [];
  const moved = await tx
    .update(activities)
    .set({ assigneeUserId: to, updatedAt: new Date(), version: sql`${activities.version} + 1` })
    .where(
      scoped(scope).where(
        activities,
        and(eq(activities[subject], subjectId), eq(activities.assigneeUserId, from), isPlannedSql),
      ),
    )
    .returning({ id: activities.id });
  for (const { id } of moved) {
    await audit.record(tx, {
      action: 'activity.reassigned',
      entityType: 'activities',
      entityId: id,
      before: { assigneeUserId: from },
      after: { assigneeUserId: to },
      meta: { reason, [subject]: subjectId },
    });
  }
  return moved.map((row) => row.id);
}
