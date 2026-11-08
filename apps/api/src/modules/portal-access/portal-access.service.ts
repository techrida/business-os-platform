// PortalAccessService (K8): gives a KYB-verified customer a portal admin. Serves the NFRs:
// - "authorization is deny-by-default": staff only (a portal caller holding customer.write is still refused),
//   and the record-level customer.write check answers 404 outside the caller's scope;
// - "role assignment has one source of truth": the org, the user and the customer_user grant are made in
//   ZITADEL first, and app.idp_orgs / app.users only mirror them;
// - "every change is audited": the attempt, each ZITADEL step and the result each get an audit row naming the
//   staff admin.
//
// ZITADEL is external, so no transaction is held open across its calls. The order is:
//   1. preflight read (customer, contact, KYB case, existing portal org) and a "requested" audit row;
//   2. org: reuse idp_orgs, else find the ZITADEL org by its deterministic name, else create it; then link it
//      in idp_orgs (its own transaction, insert-or-reuse);
//   3. the org's login policy pinned, project grant to the org, user find-or-create by email, role grant,
//      invite mail;
//   4. one transaction under the Idempotency-Key that mirrors the user and writes the step audit rows.
// A pending row cannot be written before step 2: idp_orgs.zitadel_org_id and users.zitadel_user_id are NOT
// NULL and neither table has a pending state. Retries are safe instead because every step is find-or-create:
// an existing org or user is found by name or email, and a 409 from a concurrent create falls back to the
// lookup. The invite is mailed when the user was created now, or when an earlier attempt created the user but
// died before mirroring it (the user is still invited in ZITADEL and has no app.users row).
//
// Login policy (D23 = C): a new org inherits the instance login policy, which may allow self-registration, so
// every grant pins PORTAL_LOGIN_POLICY on the org (registration off, MFA forced and never skippable) before
// any user exists in it. It runs on a reused org too, so orgs made before this call get fixed on their next
// grant. If it fails, no user is created.
import type { RoleKey } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import {
  PORTAL_LOGIN_POLICY,
  ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
} from '../../platform/users/zitadel-admin.client';
import { customerRef } from '../customers/customers.service';
import { PortalAccessCaller } from './portal-access.caller';
import {
  PortalAccessStore,
  type GrantPortalAccessBody,
  type PortalAccessDto,
  type PortalAccessStep,
} from './portal-access.types';

/** The only role a portal admin gets (the seed grants the same one to its customer org). */
export const PORTAL_ROLES: readonly RoleKey[] = ['customer_user'];

/**
 * The ZITADEL org name of a customer. ZITADEL org names are unique in the whole instance and legal names are
 * not, so the party id makes it unique, and a retry finds the same org by the same name.
 */
export function portalOrgName(legalName: string, partyId: string): string {
  return `${legalName} [${partyId}]`;
}

/** ZITADEL wants a given and a family name; a one-word contact name gets "-" as the family name. */
function splitName(fullName: string): { givenName: string; familyName: string } {
  const [givenName = fullName, ...rest] = fullName.trim().split(/\s+/);
  return { givenName, familyName: rest.length > 0 ? rest.join(' ') : '-' };
}

const notFound = (what: 'Customer' | 'Contact') =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });

const isConflict = (error: unknown) => error instanceof ZitadelHttpError && error.status === 409;

@Injectable()
export class PortalAccessService {
  constructor(
    private readonly store: PortalAccessStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly caller: PortalAccessCaller,
  ) {}

  async grant(
    customerId: string,
    body: GrantPortalAccessBody,
    idempotencyKey: string,
  ): Promise<{ status: number; response: PortalAccessDto }> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);

    const target = await this.store.loadTarget(scope.tenantId, customerId, body.contactId);
    if (!target) throw notFound('Customer');
    const decision = can(principal, 'customer.write', customerRef(target.customer, principal));
    if (!decision.allowed) {
      if (decision.reason === 'out_of_scope') throw notFound('Customer');
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: decision.reason,
      });
    }
    if (target.customer.mergedIntoId !== null) {
      throw new ConflictException({
        code: 'customer_merged',
        message: 'This customer was merged into another; grant access on the surviving customer',
      });
    }
    if (!target.contact) throw notFound('Contact');
    if (target.kybStatus !== 'approved') {
      throw new ConflictException({
        code: 'kyb_not_verified',
        message: 'Portal access needs an approved KYB verification case',
      });
    }
    const email = target.contact.emailNorm;
    if (email === null || email === '') {
      throw new BadRequestException({
        code: 'contact_email_missing',
        message: 'The contact needs an email address to receive the portal invite',
      });
    }

    await this.store.recordRequested(scope, actor, customerId, body.contactId);
    const steps: PortalAccessStep[] = [];
    try {
      // --- 2. The customer's portal org. ---
      let idpOrgId: string;
      let zitadelOrgId: string;
      if (target.idpOrg) {
        ({ idpOrgId, zitadelOrgId } = target.idpOrg);
      } else {
        const name = portalOrgName(target.customer.legalName, customerId);
        const found = await this.zitadel.findOrganizationByName(name);
        zitadelOrgId = found ?? (await this.createOrg(name));
        steps.push({
          action: found ? 'portal_access.zitadel_org_reused' : 'portal_access.zitadel_org_created',
          meta: { zitadelOrgId, name },
        });
        const owner = await this.store.idpOrgByZitadelId(zitadelOrgId);
        if (owner && (owner.tenantId !== scope.tenantId || owner.partyId !== customerId)) {
          // Never remap an org that already belongs to someone else.
          throw new ConflictException({
            code: 'idp_org_taken',
            message: 'The portal organization name is already used by another party',
          });
        }
        ({ idpOrgId } = await this.store.linkOrg(scope, actor, {
          partyId: customerId,
          zitadelOrgId,
          name,
        }));
      }

      // --- 3. Login policy, project grant, user, role, invite. ---
      const policy = await this.zitadel.ensureOrgLoginPolicy(zitadelOrgId, PORTAL_LOGIN_POLICY);
      steps.push({
        action: 'portal_access.login_policy_pinned',
        meta: { zitadelOrgId, result: policy },
      });

      await this.zitadel.ensureProjectGrant(zitadelOrgId, PORTAL_ROLES);
      steps.push({
        action: 'portal_access.project_granted',
        meta: { zitadelOrgId, roles: PORTAL_ROLES },
      });

      const names = splitName(target.contact.fullName);
      const found = await this.zitadel.findHumanByUsername(zitadelOrgId, email);
      let user: { id: string; status: string | null };
      let created = false;
      if (found) {
        user = found;
      } else {
        try {
          // A new human is in ZITADEL's initial state until the invite is accepted. No re-read: the
          // user list is a projection that can lag a moment behind the write.
          user = {
            id: await this.zitadel.createHuman(zitadelOrgId, { email, ...names }),
            status: 'invited',
          };
          created = true;
        } catch (error) {
          if (!isConflict(error)) throw error;
          // A concurrent grant created the same user a moment ago: use that one.
          const raced = await this.zitadel.findHumanByUsername(zitadelOrgId, email);
          if (!raced) throw error;
          user = raced;
        }
      }
      steps.push({
        action: created
          ? 'portal_access.zitadel_user_created'
          : 'portal_access.zitadel_user_reused',
        meta: { zitadelOrgId, zitadelUserId: user.id },
      });

      await this.zitadel.setGrants(user.id, zitadelOrgId, PORTAL_ROLES);
      steps.push({
        action: 'portal_access.role_granted',
        meta: { zitadelUserId: user.id, roles: PORTAL_ROLES },
      });

      const inviteSent =
        created || (user.status === 'invited' && !(await this.store.isMirrored(user.id)));
      if (inviteSent) {
        await this.zitadel.sendInviteCode(user.id);
        steps.push({ action: 'portal_access.invite_sent', meta: { zitadelUserId: user.id } });
      }

      // --- 4. Mirror and audit under the Idempotency-Key. ---
      const done = await this.store.finish(scope, actor, {
        idempotencyKey,
        customerId,
        contactId: body.contactId,
        idpOrgId,
        zitadelUserId: user.id,
        email,
        displayName: target.contact.fullName,
        inviteSent,
        steps,
      });
      return { status: done.status, response: done.response };
    } catch (error) {
      if (error instanceof ZitadelNotConfiguredError) {
        throw new ServiceUnavailableException({
          code: 'idp_not_configured',
          message: 'Portal access is unavailable: the identity provider is not configured',
        });
      }
      throw error;
    }
  }

  /** A 409 means a concurrent first grant created the org a moment ago: use that one. */
  private async createOrg(name: string): Promise<string> {
    try {
      return await this.zitadel.createOrganization(name);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const raced = await this.zitadel.findOrganizationByName(name);
      if (!raced) throw error;
      return raced;
    }
  }
}

/** Portal access is granted by staff only: a portal user holding customer.write by mistake is still refused. */
function assertStaff(p: Principal): void {
  if (p.orgKind !== 'staff') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
  }
}
