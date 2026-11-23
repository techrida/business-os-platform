// The Owner filter of the opportunities list (D52(e), U13): the people a viewer can filter deals by, without the
// admin directory most staff may not read. Same semantics as the leads list's filter (LeadsService.ownerFilter):
// everyone who owns an opportunity the viewer can read, plus whoever the viewer may hand an opportunity's work to
// under the entity's stored rule for opportunities, so a salesperson finds a colleague before that colleague owns
// a deal. A provider of its own because it needs the live role grants (RoleCache) that OpportunitiesService does
// not use.
import { type LeadOwnerOption, type Permission } from '@bos/contracts';
import { opportunities, scoped } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, isNotNull } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, READ_ONLY } from '../../platform/db/tx';
import { personNames } from '../../platform/users/person-names';
import { assignableParties, storedAssignmentRule } from '../leads/lead-assignee';
import { OpportunitiesCaller } from './opportunities.caller';

/** Picker order: by name, then id, so two people of one name keep a stable order. */
const byName = (a: LeadOwnerOption, b: LeadOwnerOption): number =>
  a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId);

@Injectable()
export class OpportunityOwnersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: OpportunitiesCaller,
    private readonly roleCache: RoleCache,
  ) {}

  /**
   * The people the caller may hand an opportunity to (F1-Q51, the owner select): exactly whom
   * `PATCH /v1/opportunities/:id/owner` accepts, so the select never offers a 400. The assignment rule's targets
   * under the entity's stored rule for opportunities, among the active staff of the acting entity who can read and
   * write opportunities (the leads' owner rule: a read-only role never owns a deal). Names only, no address.
   */
  owners(): Promise<LeadOwnerOption[]> {
    return this.parties('crm.opportunity.write');
  }

  /**
   * The people the caller may assign a follow-up on an opportunity to: the same rule as the owner select, but a
   * reader of opportunities is enough (the follow-up check, ActivitiesService.assertAssignee), so a read-only
   * colleague such as Management can still be given a call to make. Names only, no address.
   */
  followUpAssignees(): Promise<LeadOwnerOption[]> {
    return this.parties(undefined);
  }

  private parties(ownerWrite: Permission | undefined): Promise<LeadOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const people = await assignableParties(tx, principal, scope, {
          roleCache: this.roleCache,
          context: 'reassign',
          rule: storedAssignmentRule(tx, scope, 'opportunities'),
          subjectRead: 'crm.opportunity.read',
          ...(ownerWrite === undefined ? {} : { ownerWrite }),
        });
        return people
          .map((c) => ({
            userId: c.userId,
            displayName: c.displayName?.trim() || 'Unnamed user',
            email: '',
            avatarDocumentId: c.avatarDocumentId,
            role: c.role,
          }))
          .sort(byName);
      },
      READ_ONLY,
    );
  }

  /**
   * The filter's people, by name. The owners come from the list's own scope SQL, so the filter names nobody whose
   * deal the list would hide. Hand-over targets are added only for a caller who may work opportunities at all.
   * Names are the records' person names ("Unnamed user" without a display name) and no address is sent
   * (`email` is empty): the filter only needs to tell people apart.
   */
  async ownerFilter(): Promise<LeadOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const owned = await tx
          .selectDistinct({ userId: opportunities.ownerUserId })
          .from(opportunities)
          .where(
            scoped(scope).where(
              opportunities,
              and(
                scopeWhereFor(principal, opportunities, 'crm.opportunity.read'),
                isNotNull(opportunities.ownerUserId),
              ),
            ),
          );
        const ids = new Set<string>();
        for (const { userId } of owned) if (userId !== null) ids.add(userId);
        if (can(principal, 'crm.opportunity.write').allowed) {
          const targets = await assignableParties(tx, principal, scope, {
            roleCache: this.roleCache,
            context: 'reassign',
            rule: storedAssignmentRule(tx, scope, 'opportunities'),
            subjectRead: 'crm.opportunity.read',
          });
          for (const { userId } of targets) ids.add(userId);
        }
        const named = new Map(
          (await personNames(tx, scope.tenantId, ids)).map((p) => [p.userId, p]),
        );
        return [...ids]
          .map((userId) => ({
            userId,
            displayName: named.get(userId)?.name ?? 'Unnamed user',
            email: '',
            avatarDocumentId: named.get(userId)?.avatarDocumentId ?? null,
          }))
          .sort(byName);
      },
      READ_ONLY,
    );
  }
}
