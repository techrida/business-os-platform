// Handing an opportunity to another person (F1-Q51). The same assignment rule as a lead's owner (D38/D50:
// `assertAssignable` under the entity's stored rule for opportunities), the old owner's open follow-ups on the deal
// move with it (D45, the shared `moveOpenFollowUps`), and the change is audited. A provider of its own because it
// needs the live role grants (RoleCache) and the notice outbox, which OpportunitiesService does not use.
import { type OpportunityDto, type OpportunityOwnerChangeBody } from '@bos/contracts';
import { opportunities, scoped, users } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { type Principal } from '../../platform/authz/can';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { NotifyService } from '../../platform/notify/notify.service';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { moveOpenFollowUps } from '../activities/follow-ups';
import { lostReasonRefs } from '../leads/lost-reasons.service';
import { assertAssignable, storedAssignmentRule } from '../leads/lead-assignee';
import { OpportunitiesCaller } from './opportunities.caller';
import { type OpportunityRow, toOpportunityDto } from './opportunities.types';
import { opportunityRef } from './opportunity-stage';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

@Injectable()
export class OpportunityOwnerChangeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: OpportunitiesCaller,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly roleCache: RoleCache,
  ) {}

  /**
   * Checks run in this order, the first failure is the answer: out of the caller's write scope 404, stale version
   * 409, a closed deal (won or lost) 400, the same owner 400, then the new owner under the assignment rule (context
   * `reassign`: an active staff member of the entity whom the rule lets the caller hand work to and who can read
   * opportunities, else 400 with `details.assignmentReason`). The database re-stamps the deal's department (and its
   * quotations') from the new owner (D55-4). A new owner other than the caller is told (`crm.assigned`, #22).
   */
  async changeOwner(id: string, body: OpportunityOwnerChangeBody): Promise<OpportunityDto> {
    const { scope, actor, principal } = this.caller.current();
    const sent = { notice: false };
    const changed = await withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.assertWritable(row);
      if (row.version !== body.expectedVersion) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This record was changed by someone else; reload it and try again',
        });
      }
      if (row.stage === 'won' || row.stage === 'lost') {
        throw new BadRequestException({
          code: 'bad_request',
          message: `A ${row.stage} opportunity cannot change owner`,
        });
      }
      if (row.ownerUserId === body.ownerUserId) {
        throw new BadRequestException({ code: 'bad_request', message: 'Nothing to change' });
      }
      await assertAssignable(tx, principal, scope, body.ownerUserId, 'ownerUserId', {
        roleCache: this.roleCache,
        context: 'reassign',
        rule: storedAssignmentRule(tx, scope, 'opportunities'),
        subjectRead: 'crm.opportunity.read',
      });

      const updated = await updateVersioned(tx, opportunities, id, body.expectedVersion, {
        ownerUserId: body.ownerUserId,
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'opportunity.owner_changed',
        entityType: 'opportunities',
        entityId: id,
        before: { ownerUserId: row.ownerUserId, departmentId: row.departmentId },
        after: { ownerUserId: updated.ownerUserId, departmentId: updated.departmentId },
      });
      await moveOpenFollowUps(tx, scope, this.audit, {
        subject: 'opportunityId',
        subjectId: id,
        from: row.ownerUserId,
        to: body.ownerUserId,
        reason: 'opportunity_owner_changed',
      });
      if (body.ownerUserId !== principal.userId) {
        await this.notifyAssigned(tx, principal, updated);
        sent.notice = true;
      }
      const names = await personNameMap(tx, updated.tenantId, [updated.ownerUserId]);
      const lostReason =
        updated.lostReasonId === null
          ? null
          : ((await lostReasonRefs(tx, updated.tenantId, [updated.lostReasonId])).get(
              updated.lostReasonId,
            ) ?? null);
      return toOpportunityDto(updated, nameIn(names, updated.ownerUserId), lostReason, principal);
    });
    if (sent.notice) await this.notify.nudge();
    return changed;
  }

  /** `crm.assigned` (#22) to the new owner: the bell row and the email, in the change's own transaction. */
  private async notifyAssigned(
    tx: DbTransaction,
    principal: Principal,
    deal: OpportunityRow,
  ): Promise<void> {
    if (deal.ownerUserId === null) return;
    const [me] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, deal.tenantId), eq(users.id, principal.userId)));
    const assignerName = me?.displayName?.trim() || 'Unnamed user';
    const linkPath = `/opportunities/${deal.id}`;
    await this.notify.notifyUser(tx, {
      userId: deal.ownerUserId,
      title: `Opportunity ${deal.number} assigned to you`,
      body: `${assignerName} assigned the opportunity ${deal.number} (${deal.name}) to you.`,
      link: linkPath,
      email: {
        template: 'crm.assigned',
        vars: { entityType: 'opportunity', entityName: deal.number, assignerName, linkPath },
      },
      dedupeKey: `crm.assigned:opportunity:${deal.id}:${deal.version}`,
    });
  }

  /** The write check of OpportunitiesService: out of scope is a 404, any other denial stays a 403. */
  private assertWritable(row: OpportunityRow): void {
    try {
      this.authz.assert('crm.opportunity.write', opportunityRef(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }

  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<OpportunityRow> {
    const [row] = await tx
      .select()
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
      .for('update');
    if (row === undefined) throw notFound();
    return row;
  }
}
