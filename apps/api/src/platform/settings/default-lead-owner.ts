// Who may be the entity's default lead owner (crm.default_lead_owner, F1-Q21 and R4a Q10).
//
// The setting is read in one place: a lead started by someone who only takes leads in for Sales (Finance,
// Accountant, PMO; `sales_owner_required`) and names no owner goes to the default owner when that person is one the
// lead may be handed to, else to the Sales head (LeadsService.ownerForCreate). So the people worth offering, and the
// only ones a save accepts, are those that fallback would keep:
// - active staff members of the acting entity (not portal users, not disabled, not of another tenant or entity);
// - allowed by the assignment rule for an intake hand-off on create: a Sales user with a department
//   (`decideAssignment`, `intake_handoff`);
// - able to own a lead with their live grants: lead read that reaches what they own, and lead write.
// The same parts as `assignableParties` (lead-assignee.ts), with the intake creator in place of the caller, so the
// list does not depend on who edits the setting. Someone who stops qualifying later is skipped by the fallback (the
// Sales head gets the lead); nothing rewrites the stored value.
import {
  LEAD_INTAKE_ROLE_KEYS,
  type AssignmentDenyReason,
  type AssignmentParty,
  type SettingsPerson,
} from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';

import { decideAssignment } from '../../modules/leads/lead-assignment-rule';
import {
  type AssignmentCandidate,
  loadAssignmentParties,
  partyHolds,
} from '../../modules/leads/lead-assignee';
import type { RoleCache } from '../authz/role-cache';
import type { DbTransaction } from '../db/tx';

type EntityScope = { tenantId: string; organizationId: string };

/** Someone who only starts leads for Sales: the creator the default owner exists for. */
const INTAKE_CREATOR: AssignmentParty = {
  userId: '',
  roleKeys: [LEAD_INTAKE_ROLE_KEYS[0]],
  departmentId: null,
  level: 'staff',
};

/** Why `candidate` cannot be the default owner, or null when they can. */
async function refusal(
  roleCache: RoleCache,
  scope: EntityScope,
  candidate: AssignmentCandidate,
): Promise<AssignmentDenyReason | null> {
  const decision = decideAssignment(INTAKE_CREATOR, candidate, 'create');
  if (!decision.allowed) return decision.reason;
  const mayOwn =
    (await partyHolds(roleCache, scope, candidate, 'crm.lead.read', true)) &&
    (await partyHolds(roleCache, scope, candidate, 'crm.lead.write', false));
  return mayOwn ? null : 'cannot_read_subject';
}

const shownName = (displayName: string | null): string => displayName?.trim() || 'Unnamed user';

/** The people the Lead owner card offers, by name then id. */
export async function defaultLeadOwnerCandidates(
  tx: DbTransaction,
  scope: EntityScope,
  roleCache: RoleCache,
): Promise<SettingsPerson[]> {
  const out: SettingsPerson[] = [];
  for (const candidate of await loadAssignmentParties(tx, scope)) {
    if ((await refusal(roleCache, scope, candidate)) === null) {
      out.push({
        userId: candidate.userId,
        displayName: shownName(candidate.displayName),
        role: candidate.role,
      });
    }
  }
  return out.sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
  );
}

/**
 * Returns when `userId` may be the default lead owner; else 400 with the rule's code in `details.assignmentReason`
 * (`not_active_staff` for a portal, disabled or unknown user or one of another tenant or entity).
 */
export async function assertDefaultLeadOwner(
  tx: DbTransaction,
  scope: EntityScope,
  roleCache: RoleCache,
  userId: string,
): Promise<void> {
  const [candidate] = await loadAssignmentParties(tx, scope, [userId]);
  const reason =
    candidate === undefined ? 'not_active_staff' : await refusal(roleCache, scope, candidate);
  if (reason === null) return;
  throw new BadRequestException({
    code: 'bad_request',
    message: 'This person cannot be given new leads. Choose someone from the list.',
    details: { assignmentReason: reason },
  });
}
