// Who may start a quotation on an opportunity (R4a Q4 a): its owner, the owner's department, or the creator of the
// lead it came from. Reading every deal (Finance and Accountant since U20a2-Q4) is not enough, and an assigned
// follow-up is not either (FX-Q2). The Founder is the one exemption (Kuu, 2026-11-21, P5-Q2): they draft on any deal. Both the record check (the DTO flag) and the SQL lookup in
// DraftingService use `draftReachPrincipal`, so the two cannot drift.
import type { AccessScope, Permission } from '@bos/contracts';

import { can, type Principal } from '../../platform/authz/can';
import { opportunityRef } from './opportunity-stage';

const READ: Permission = 'crm.opportunity.read';

/**
 * `principal` with its opportunity read capped at `department`: own deals (owner or lead creator) and the deals of
 * its own department. `own` and `department` stay as they are; no grant is ever widened. The Founder is not capped:
 * their read stays as it is, so every deal is within reach.
 */
export function draftReachPrincipal(principal: Principal): Principal {
  if (principal.roles.includes('founder')) return principal;
  if (principal.grants.get(READ) !== 'all') return principal;
  const grants = new Map<Permission, AccessScope>(principal.grants);
  grants.set(READ, 'department');
  return { ...principal, grants };
}

/**
 * May `principal` start a quotation on `row`? A staff caller with `quotation.draft` whose capped opportunity read
 * reaches the deal as owner, lead creator or through its department. The SQL twin is DraftingService's
 * `findOpportunity` (`scopeWhereFor(draftReachPrincipal(p), ..., { assignees: false })`).
 */
export function mayStartQuotationOn(
  principal: Principal,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId: string | null;
    leadCreatorUserId: string | null;
  },
): boolean {
  if (principal.orgKind !== 'staff') return false;
  const draft = can(principal, 'quotation.draft', {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: principal.userId,
  });
  if (!draft.allowed) return false;
  return can(
    draftReachPrincipal(principal),
    READ,
    opportunityRef(row, { creatorUserId: row.leadCreatorUserId, assigneeUserIds: [] }),
  ).allowed;
}
