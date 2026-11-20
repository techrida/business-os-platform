// PortalAccessService (K8): gives a KYB-verified customer a portal admin. VendorPortalAccessService (K4) does the
// same for a vendor that is approved, or pending_kyc with onboarding-only access. Serves the NFRs:
// - "authorization is deny-by-default": staff only (a portal caller holding customer.write or vendor.write is still
//   refused), and the record-level customer.write / vendor.write check answers 404 outside the caller's scope;
// - "role assignment has one source of truth": the org, the user and the portal role grant (customer_user or
//   vendor_user) are made in ZITADEL first, and app.idp_orgs / app.users only mirror them;
// - "every change is audited": the attempt, each ZITADEL step and the result each get an audit row naming the
//   staff admin;
// - F1-Q31: a customer's first portal admin is invited by its account owner (customers.owner_user_id) and is one
//   of its existing contacts (the body names a contact id, never an email). Once the customer has a portal user,
//   later grants need customer.write only.
//
// ZITADEL is external, so no transaction is held open across its calls. The order is:
//   1. preflight read (party, contact, KYB case or vendor status, existing portal org) and a "requested" audit row;
//   2. org: reuse idp_orgs, else find the ZITADEL org by its deterministic name, else create it; then link it
//      in idp_orgs with the party's kind (its own transaction, insert-or-reuse);
//   3. the org's login policy pinned, project grant to the org, user find-or-create by email, role grant,
//      invite mail;
//   4. one transaction under the Idempotency-Key that mirrors the user and writes the step audit rows.
// Steps 2 and 3 are the same for both kinds (provisionPortalAdmin); only the role and the idp_orgs kind differ.
// A pending row cannot be written before step 2: idp_orgs.zitadel_org_id and users.zitadel_user_id are NOT
// NULL and neither table has a pending state. Retries are safe instead because every step is find-or-create:
// an existing org or user is found by name or email, and a 409 from a concurrent create falls back to the
// lookup. The invite is mailed when the user was created now, or when an earlier attempt created the user but
// died before mirroring it (the user is still invited in ZITADEL and has no app.users row).
//
// Login policy (D23 = C, D11 closed registration): a new org inherits the instance login policy, which may allow
// self-registration, so every grant pins PORTAL_LOGIN_POLICY on the org (registration off, MFA forced and never
// skippable) before any user exists in it. It runs on a reused org too, so orgs made before this call get fixed on
// their next grant. If it fails, no user is created.
import { type RoleKey, type VendorStatus, vendorPortalCapability } from '@bos/contracts';
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
import type { Actor, TxScope } from '../../platform/db/tx';
import {
  PORTAL_LOGIN_POLICY,
  ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
} from '../../platform/users/zitadel-admin.client';
import { customerRef } from '../customers/customers.service';
import { vendorRef } from '../vendors/vendors.service';
import { firstAdminRule, type FirstAdminRule } from './first-admin';
import { PortalAccessCaller } from './portal-access.caller';
import {
  PortalAccessStore,
  VendorPortalAccessStore,
  type GrantPortalAccessBody,
  type GrantVendorPortalAccessBody,
  type IdpOrgOwner,
  type PortalAccessDto,
  type PortalAccessStep,
  type VendorPortalAccessDto,
} from './portal-access.types';

/** The only role a portal admin gets (the seed grants the same one to its customer org). */
export const PORTAL_ROLES: readonly RoleKey[] = ['customer_user'];

/** The only role a vendor portal admin gets (`portal.vendor.read` / `portal.vendor.submit`, CT). */
export const VENDOR_PORTAL_ROLES: readonly RoleKey[] = ['vendor_user'];

/**
 * The vendor statuses a portal grant accepts (K4): approved (full access), or pending_kyc so the vendor can upload
 * its KYC documents with onboarding-only access. Any other status answers 409 before ZITADEL is called.
 */
export const VENDOR_PORTAL_GRANTABLE: readonly VendorStatus[] = ['approved', 'pending_kyc'];

/**
 * The ZITADEL org name of a customer or vendor. ZITADEL org names are unique in the whole instance and legal names
 * are not, so the party id makes it unique, and a retry finds the same org by the same name.
 */
export function portalOrgName(legalName: string, partyId: string): string {
  return `${legalName} [${partyId}]`;
}

/** ZITADEL wants a given and a family name; a one-word contact name gets "-" as the family name. */
function splitName(fullName: string): { givenName: string; familyName: string } {
  const [givenName = fullName, ...rest] = fullName.trim().split(/\s+/);
  return { givenName, familyName: rest.length > 0 ? rest.join(' ') : '-' };
}

const notFound = (what: 'Customer' | 'Vendor' | 'Contact') =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });

const isConflict = (error: unknown) => error instanceof ZitadelHttpError && error.status === 409;

/**
 * The contact is not one of this customer's (or does not exist). Still the 404 of a hidden record, with a message
 * that names the rule: a portal admin is always one of the customer's existing contacts (F1-Q31), never a new email.
 */
const contactNotOnCustomer = () =>
  new NotFoundException({
    code: 'not_found',
    message:
      "Contact not found on this customer. The portal admin must be one of the customer's existing contacts",
  });

/**
 * F1-Q31: the first portal admin is invited by the customer's account owner only. Both refusals are 409s, like
 * kyb_not_verified: they depend on the customer's state (no portal user yet), and another caller or a set owner
 * clears them.
 */
function assertFirstAdminRule(rule: FirstAdminRule): void {
  if (rule === 'owner_only') {
    throw new ConflictException({
      code: 'first_admin_owner_only',
      message: "Only the customer's account owner can invite its first portal admin",
    });
  }
  if (rule === 'owner_missing') {
    throw new ConflictException({
      code: 'account_owner_missing',
      message: 'Assign an account owner to this customer; the owner invites its first portal admin',
    });
  }
}

const emailMissing = () =>
  new BadRequestException({
    code: 'contact_email_missing',
    message: 'The contact needs an email address to receive the portal invite',
  });

/** The store calls steps 2 and 3 need, whichever the party kind. */
interface ProvisionPorts {
  idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null>;
  isMirrored(zitadelUserId: string): Promise<boolean>;
  linkOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }>;
}

interface ProvisionInput {
  scope: TxScope;
  actor: Actor;
  partyId: string;
  legalName: string;
  /** The party's portal org, or null before the first grant. */
  idpOrg: { idpOrgId: string; zitadelOrgId: string } | null;
  fullName: string;
  email: string;
  roles: readonly RoleKey[];
}

interface Provisioned {
  idpOrgId: string;
  zitadelUserId: string;
  inviteSent: boolean;
  steps: PortalAccessStep[];
}

/** Steps 2 and 3: the party's portal org, its login policy and project grant, the user, its role and invite. */
async function provisionPortalAdmin(
  zitadel: ZitadelAdminClient,
  ports: ProvisionPorts,
  i: ProvisionInput,
): Promise<Provisioned> {
  const steps: PortalAccessStep[] = [];
  // --- 2. The party's portal org. ---
  let idpOrgId: string;
  let zitadelOrgId: string;
  if (i.idpOrg) {
    ({ idpOrgId, zitadelOrgId } = i.idpOrg);
  } else {
    const name = portalOrgName(i.legalName, i.partyId);
    const found = await zitadel.findOrganizationByName(name);
    zitadelOrgId = found ?? (await createOrg(zitadel, name));
    steps.push({
      action: found ? 'portal_access.zitadel_org_reused' : 'portal_access.zitadel_org_created',
      meta: { zitadelOrgId, name },
    });
    const owner = await ports.idpOrgByZitadelId(zitadelOrgId);
    if (owner && (owner.tenantId !== i.scope.tenantId || owner.partyId !== i.partyId)) {
      // Never remap an org that already belongs to someone else.
      throw new ConflictException({
        code: 'idp_org_taken',
        message: 'The portal organization name is already used by another party',
      });
    }
    ({ idpOrgId } = await ports.linkOrg(i.scope, i.actor, {
      partyId: i.partyId,
      zitadelOrgId,
      name,
    }));
  }

  // --- 3. Login policy, project grant, user, role, invite. ---
  const policy = await zitadel.ensureOrgLoginPolicy(zitadelOrgId, PORTAL_LOGIN_POLICY);
  steps.push({
    action: 'portal_access.login_policy_pinned',
    meta: { zitadelOrgId, result: policy },
  });

  await zitadel.ensureProjectGrant(zitadelOrgId, i.roles);
  steps.push({
    action: 'portal_access.project_granted',
    meta: { zitadelOrgId, roles: i.roles },
  });

  const names = splitName(i.fullName);
  const found = await zitadel.findHumanByUsername(zitadelOrgId, i.email);
  let user: { id: string; status: string | null };
  let created = false;
  if (found) {
    user = found;
  } else {
    try {
      // A new human is in ZITADEL's initial state until the invite is accepted. No re-read: the
      // user list is a projection that can lag a moment behind the write.
      user = {
        id: await zitadel.createHuman(zitadelOrgId, { email: i.email, ...names }),
        status: 'invited',
      };
      created = true;
    } catch (error) {
      if (!isConflict(error)) throw error;
      // A concurrent grant created the same user a moment ago: use that one.
      const raced = await zitadel.findHumanByUsername(zitadelOrgId, i.email);
      if (!raced) throw error;
      user = raced;
    }
  }
  steps.push({
    action: created ? 'portal_access.zitadel_user_created' : 'portal_access.zitadel_user_reused',
    meta: { zitadelOrgId, zitadelUserId: user.id },
  });

  await zitadel.setGrants(user.id, zitadelOrgId, i.roles);
  steps.push({
    action: 'portal_access.role_granted',
    meta: { zitadelUserId: user.id, roles: i.roles },
  });

  const inviteSent = created || (user.status === 'invited' && !(await ports.isMirrored(user.id)));
  if (inviteSent) {
    await zitadel.sendInviteCode(user.id);
    steps.push({ action: 'portal_access.invite_sent', meta: { zitadelUserId: user.id } });
  }
  return { idpOrgId, zitadelUserId: user.id, inviteSent, steps };
}

/** A 409 means a concurrent first grant created the org a moment ago: use that one. */
async function createOrg(zitadel: ZitadelAdminClient, name: string): Promise<string> {
  try {
    return await zitadel.createOrganization(name);
  } catch (error) {
    if (!isConflict(error)) throw error;
    const raced = await zitadel.findOrganizationByName(name);
    if (!raced) throw error;
    return raced;
  }
}

/** A missing ZITADEL provisioner credential reads as 503 idp_not_configured; anything else passes through. */
async function mapIdpErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
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

/** Record-level authz: 404 outside the caller's scope, 403 for any other refusal. */
function assertAllowed(decision: ReturnType<typeof can>, what: 'Customer' | 'Vendor'): void {
  if (decision.allowed) return;
  if (decision.reason === 'out_of_scope') throw notFound(what);
  throw new ForbiddenException({
    code: 'forbidden',
    message: 'Forbidden',
    reason: decision.reason,
  });
}

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
    assertAllowed(
      can(principal, 'customer.write', customerRef(target.customer, principal)),
      'Customer',
    );
    if (target.customer.mergedIntoId !== null) {
      throw new ConflictException({
        code: 'customer_merged',
        message: 'This customer was merged into another; grant access on the surviving customer',
      });
    }
    assertFirstAdminRule(firstAdminRule(target.customer, principal.userId, target.hasPortalUser));
    if (!target.contact) throw contactNotOnCustomer();
    if (target.kybStatus !== 'approved') {
      throw new ConflictException({
        code: 'kyb_not_verified',
        message: 'Portal access needs an approved KYB verification case',
      });
    }
    const email = target.contact.emailNorm;
    if (email === null || email === '') throw emailMissing();
    const { fullName } = target.contact;

    await this.store.recordRequested(scope, actor, customerId, body.contactId);
    return mapIdpErrors(async () => {
      const done = await provisionPortalAdmin(
        this.zitadel,
        {
          idpOrgByZitadelId: (z) => this.store.idpOrgByZitadelId(z),
          isMirrored: (z) => this.store.isMirrored(z),
          linkOrg: (s, a, i) => this.store.linkOrg(s, a, i),
        },
        {
          scope,
          actor,
          partyId: customerId,
          legalName: target.customer.legalName,
          idpOrg: target.idpOrg,
          fullName,
          email,
          roles: PORTAL_ROLES,
        },
      );
      // --- 4. Mirror and audit under the Idempotency-Key. ---
      const finished = await this.store.finish(scope, actor, {
        idempotencyKey,
        customerId,
        contactId: body.contactId,
        idpOrgId: done.idpOrgId,
        zitadelUserId: done.zitadelUserId,
        email,
        displayName: fullName,
        inviteSent: done.inviteSent,
        steps: done.steps,
      });
      return { status: finished.status, response: finished.response };
    });
  }
}

/**
 * The vendor portal grant (K4). Not wired to a route yet: the route `POST /v1/vendors/:id/portal-access` with
 * `@Can('vendor.write')` and the module providers are the lead's wiring.
 */
@Injectable()
export class VendorPortalAccessService {
  constructor(
    private readonly store: VendorPortalAccessStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly caller: PortalAccessCaller,
  ) {}

  /**
   * 201 with the portal admin and its capability. 403 for a non-staff caller or one without vendor.write; 404 for a
   * vendor or contact outside the caller's scope; 409 `invalid_transition` unless the vendor is approved or
   * pending_kyc; 400 for a contact without an email. A replay with the same key answers the stored body.
   */
  async grant(
    vendorId: string,
    body: GrantVendorPortalAccessBody,
    idempotencyKey: string,
  ): Promise<{ status: number; response: VendorPortalAccessDto }> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);

    const target = await this.store.loadVendorTarget(scope.tenantId, vendorId, body.contactId);
    if (!target) throw notFound('Vendor');
    assertAllowed(can(principal, 'vendor.write', vendorRef(target.vendor, principal)), 'Vendor');
    if (!target.contact) throw notFound('Contact');
    const { status } = target.vendor;
    if (!VENDOR_PORTAL_GRANTABLE.includes(status)) {
      throw new ConflictException({
        code: 'invalid_transition',
        message: `Portal access needs an approved or pending_kyc vendor; this vendor is ${status}`,
      });
    }
    const email = target.contact.emailNorm;
    if (email === null || email === '') throw emailMissing();
    const { fullName } = target.contact;

    await this.store.recordVendorRequested(scope, actor, vendorId, body.contactId);
    return mapIdpErrors(async () => {
      const done = await provisionPortalAdmin(
        this.zitadel,
        {
          idpOrgByZitadelId: (z) => this.store.idpOrgByZitadelId(z),
          isMirrored: (z) => this.store.isMirrored(z),
          linkOrg: (s, a, i) => this.store.linkVendorOrg(s, a, i),
        },
        {
          scope,
          actor,
          partyId: vendorId,
          legalName: target.vendor.legalName,
          idpOrg: target.idpOrg,
          fullName,
          email,
          roles: VENDOR_PORTAL_ROLES,
        },
      );
      const finished = await this.store.finishVendor(scope, actor, {
        idempotencyKey,
        vendorId,
        contactId: body.contactId,
        idpOrgId: done.idpOrgId,
        zitadelUserId: done.zitadelUserId,
        email,
        displayName: fullName,
        inviteSent: done.inviteSent,
        steps: done.steps,
        capability: vendorPortalCapability(status),
      });
      return { status: finished.status, response: finished.response };
    });
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
