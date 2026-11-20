// The SQL side of portal access (K8). Reads with the pool; every write runs in withTx with the staff caller as
// the actor, so the audit rows name who granted the access. The user mirror goes through UsersStore, the same
// statements UserMirror.apply() uses, so a later sync of this user finds the row it would have written.
// K4: the same statements serve vendor grants. The party kind picks the idp_orgs kind, the audit entity type, the
// portal role and the idempotency command; the customer path is unchanged.
import type { RoleKey } from '@bos/contracts';
import {
  customerContacts,
  customers,
  idpOrgs,
  users,
  vendorContacts,
  vendors,
  verificationCases,
} from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { UsersStore } from '../../platform/users/users.store';
import { customerHasPortalUser } from './first-admin';
import { PORTAL_ROLES, VENDOR_PORTAL_ROLES } from './portal-access.service';
import {
  PortalAccessStore,
  type FinishInput,
  type IdpOrgOwner,
  type PortalAccessDto,
  type PortalPartyKind,
  type PortalTarget,
  type VendorFinishInput,
  type VendorPortalAccessDto,
  type VendorPortalAccessStore,
  type VendorPortalTarget,
} from './portal-access.types';

/** What the user mirror of a finish needs, whichever the party kind. */
interface MirrorInput {
  kind: PortalPartyKind;
  roles: readonly RoleKey[];
  partyId: string;
  contactId: string;
  idpOrgId: string;
  zitadelUserId: string;
  email: string;
  displayName: string;
  steps: FinishInput['steps'];
}

@Injectable()
export class SqlPortalAccessStore extends PortalAccessStore implements VendorPortalAccessStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersStore,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async loadTarget(
    tenantId: string,
    customerId: string,
    contactId: string,
  ): Promise<PortalTarget | null> {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    if (!customer) return null;
    const [contact] = await this.db
      .select({
        id: customerContacts.id,
        fullName: customerContacts.fullName,
        emailNorm: customerContacts.emailNorm,
      })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, tenantId),
          eq(customerContacts.customerId, customerId),
          eq(customerContacts.id, contactId),
        ),
      );
    const [kyb] = await this.db
      .select({ status: verificationCases.status })
      .from(verificationCases)
      .where(
        and(eq(verificationCases.tenantId, tenantId), eq(verificationCases.partyId, customerId)),
      );
    return {
      customer,
      contact: contact ?? null,
      kybStatus: kyb?.status ?? null,
      idpOrg: await this.portalOrgOf(tenantId, customerId, 'customer'),
      hasPortalUser: await customerHasPortalUser(this.db, tenantId, customerId),
    };
  }

  async loadVendorTarget(
    tenantId: string,
    vendorId: string,
    contactId: string,
  ): Promise<VendorPortalTarget | null> {
    const [vendor] = await this.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)));
    if (!vendor) return null;
    const [contact] = await this.db
      .select({
        id: vendorContacts.id,
        fullName: vendorContacts.fullName,
        emailNorm: vendorContacts.emailNorm,
      })
      .from(vendorContacts)
      .where(
        and(
          eq(vendorContacts.tenantId, tenantId),
          eq(vendorContacts.vendorId, vendorId),
          eq(vendorContacts.id, contactId),
        ),
      );
    return {
      vendor,
      contact: contact ?? null,
      idpOrg: await this.portalOrgOf(tenantId, vendorId, 'vendor'),
    };
  }

  /** The party's portal org of `kind`, or null before the first grant. */
  private async portalOrgOf(
    tenantId: string,
    partyId: string,
    kind: PortalPartyKind,
  ): Promise<{ idpOrgId: string; zitadelOrgId: string } | null> {
    const [org] = await this.db
      .select({ idpOrgId: idpOrgs.id, zitadelOrgId: idpOrgs.zitadelOrgId })
      .from(idpOrgs)
      .where(
        and(eq(idpOrgs.tenantId, tenantId), eq(idpOrgs.partyId, partyId), eq(idpOrgs.kind, kind)),
      );
    return org ?? null;
  }

  async idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null> {
    const [row] = await this.db
      .select({
        idpOrgId: idpOrgs.id,
        tenantId: idpOrgs.tenantId,
        kind: idpOrgs.kind,
        partyId: idpOrgs.partyId,
      })
      .from(idpOrgs)
      .where(eq(idpOrgs.zitadelOrgId, zitadelOrgId));
    return row ?? null;
  }

  async isMirrored(zitadelUserId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.zitadelUserId, zitadelUserId));
    return row !== undefined;
  }

  async recordRequested(
    scope: TxScope,
    actor: Actor,
    customerId: string,
    contactId: string,
  ): Promise<void> {
    await this.requested(scope, actor, 'customer', customerId, contactId);
  }

  async recordVendorRequested(
    scope: TxScope,
    actor: Actor,
    vendorId: string,
    contactId: string,
  ): Promise<void> {
    await this.requested(scope, actor, 'vendor', vendorId, contactId);
  }

  private async requested(
    scope: TxScope,
    actor: Actor,
    kind: PortalPartyKind,
    partyId: string,
    contactId: string,
  ): Promise<void> {
    await withTx(this.db, scope, actor, (tx) =>
      this.audit.record(tx, {
        action: 'portal_access.requested',
        entityType: kind,
        entityId: partyId,
        meta: { contactId },
      }),
    );
  }

  async linkOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }> {
    return this.link(scope, actor, 'customer', i);
  }

  async linkVendorOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }> {
    return this.link(scope, actor, 'vendor', i);
  }

  /** idp_orgs_tenant_party_kind_fk refuses a party of another kind, so a vendor never sits behind a customer org. */
  private async link(
    scope: TxScope,
    actor: Actor,
    kind: PortalPartyKind,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }> {
    return withTx(this.db, scope, actor, async (tx) => {
      // Both unique keys (tenant + party, and the ZITADEL org id) may be the one a concurrent grant took.
      const [inserted] = await tx
        .insert(idpOrgs)
        .values({
          tenantId: scope.tenantId,
          zitadelOrgId: i.zitadelOrgId,
          kind,
          partyId: i.partyId,
          name: i.name,
        })
        .onConflictDoNothing()
        .returning({ id: idpOrgs.id });
      if (inserted) {
        await this.audit.record(tx, {
          action: 'portal_access.org_linked',
          entityType: kind,
          entityId: i.partyId,
          meta: { idpOrgId: inserted.id, zitadelOrgId: i.zitadelOrgId },
        });
        return { idpOrgId: inserted.id, created: true };
      }
      const [existing] = await tx
        .select({ id: idpOrgs.id, zitadelOrgId: idpOrgs.zitadelOrgId })
        .from(idpOrgs)
        .where(and(eq(idpOrgs.tenantId, scope.tenantId), eq(idpOrgs.partyId, i.partyId)));
      if (!existing || existing.zitadelOrgId !== i.zitadelOrgId) {
        // The party already has another portal org, or the ZITADEL org is mapped elsewhere: never remap.
        throw new Error(
          'idp_orgs conflict: the party or the ZITADEL org is already linked elsewhere',
        );
      }
      return { idpOrgId: existing.id, created: false };
    });
  }

  async finish(
    scope: TxScope,
    actor: Actor,
    i: FinishInput,
  ): Promise<{ status: number; response: PortalAccessDto; replayed: boolean }> {
    return withTx(this.db, scope, actor, (tx) =>
      withIdempotency<PortalAccessDto>(
        tx,
        {
          command: 'customer.portal_access.grant',
          key: i.idempotencyKey,
          body: { customerId: i.customerId, contactId: i.contactId },
        },
        async (q) => {
          const user = await this.mirror(q, scope, {
            kind: 'customer',
            roles: PORTAL_ROLES,
            partyId: i.customerId,
            contactId: i.contactId,
            idpOrgId: i.idpOrgId,
            zitadelUserId: i.zitadelUserId,
            email: i.email,
            displayName: i.displayName,
            steps: i.steps,
          });
          const response: PortalAccessDto = {
            customerId: i.customerId,
            contactId: i.contactId,
            userId: user.userId,
            idpOrgId: i.idpOrgId,
            email: i.email,
            status: user.status,
            inviteSent: i.inviteSent,
          };
          await this.granted(q, 'customer', i.customerId, i.contactId, i.idpOrgId, user);
          return { status: 201, response };
        },
      ),
    );
  }

  async finishVendor(
    scope: TxScope,
    actor: Actor,
    i: VendorFinishInput,
  ): Promise<{ status: number; response: VendorPortalAccessDto; replayed: boolean }> {
    return withTx(this.db, scope, actor, (tx) =>
      withIdempotency<VendorPortalAccessDto>(
        tx,
        {
          command: 'vendor.portal_access.grant',
          key: i.idempotencyKey,
          body: { vendorId: i.vendorId, contactId: i.contactId },
        },
        async (q) => {
          const user = await this.mirror(q, scope, {
            kind: 'vendor',
            roles: VENDOR_PORTAL_ROLES,
            partyId: i.vendorId,
            contactId: i.contactId,
            idpOrgId: i.idpOrgId,
            zitadelUserId: i.zitadelUserId,
            email: i.email,
            displayName: i.displayName,
            steps: i.steps,
          });
          const response: VendorPortalAccessDto = {
            vendorId: i.vendorId,
            contactId: i.contactId,
            userId: user.userId,
            idpOrgId: i.idpOrgId,
            email: i.email,
            status: user.status,
            inviteSent: i.inviteSent,
            capability: i.capability,
          };
          await this.granted(q, 'vendor', i.vendorId, i.contactId, i.idpOrgId, user);
          return { status: 201, response };
        },
      ),
    );
  }

  /**
   * Inside the idempotency block: mirrors the user into `app.users` (status invited, or the row already there) with
   * exactly the kind's portal roles, and writes one audit row per ZITADEL step.
   */
  private async mirror(
    q: DbTransaction,
    scope: TxScope,
    i: MirrorInput,
  ): Promise<{ userId: string; status: PortalAccessDto['status']; created: boolean }> {
    const existing = await this.users.findByZitadelId(q, i.zitadelUserId, true);
    if (existing && existing.idpOrgId !== i.idpOrgId) {
      throw new Error('app.users: this ZITADEL user is mirrored under another IdP org');
    }
    const userId =
      existing?.id ??
      (await this.users.insertUser(q, scope, {
        zitadelUserId: i.zitadelUserId,
        idpOrgId: i.idpOrgId,
        email: i.email,
        displayName: i.displayName,
        status: 'invited',
      }));
    const roles = await this.users.rolesOf(q, scope.tenantId, userId);
    if (!i.roles.every((r) => roles.includes(r)) || roles.length !== i.roles.length) {
      await this.users.replaceRoles(q, scope, userId, i.roles);
      await this.users.bumpAuthzVersion(q, scope);
    }
    for (const step of i.steps) {
      await this.audit.record(q, {
        action: step.action,
        entityType: i.kind,
        entityId: i.partyId,
        meta: { contactId: i.contactId, ...step.meta },
      });
    }
    return { userId, status: existing?.status ?? 'invited', created: !existing };
  }

  private async granted(
    q: DbTransaction,
    kind: PortalPartyKind,
    partyId: string,
    contactId: string,
    idpOrgId: string,
    user: { userId: string; created: boolean },
  ): Promise<void> {
    await this.audit.record(q, {
      action: 'portal_access.granted',
      entityType: kind,
      entityId: partyId,
      meta: { contactId, userId: user.userId, idpOrgId, created: user.created },
    });
  }
}
