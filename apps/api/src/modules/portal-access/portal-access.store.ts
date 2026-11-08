// The SQL side of portal access (K8). Reads with the pool; every write runs in withTx with the staff caller as
// the actor, so the audit rows name who granted the access. The user mirror goes through UsersStore, the same
// statements UserMirror.apply() uses, so a later sync of this user finds the row it would have written.
import { customerContacts, customers, idpOrgs, users, verificationCases } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { UsersStore } from '../../platform/users/users.store';
import { PORTAL_ROLES } from './portal-access.service';
import {
  PortalAccessStore,
  type FinishInput,
  type IdpOrgOwner,
  type PortalAccessDto,
  type PortalTarget,
} from './portal-access.types';

const ENTITY_TYPE = 'customer';

@Injectable()
export class SqlPortalAccessStore extends PortalAccessStore {
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
    const [org] = await this.db
      .select({ idpOrgId: idpOrgs.id, zitadelOrgId: idpOrgs.zitadelOrgId })
      .from(idpOrgs)
      .where(
        and(
          eq(idpOrgs.tenantId, tenantId),
          eq(idpOrgs.partyId, customerId),
          eq(idpOrgs.kind, 'customer'),
        ),
      );
    return {
      customer,
      contact: contact ?? null,
      kybStatus: kyb?.status ?? null,
      idpOrg: org ?? null,
    };
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
    await withTx(this.db, scope, actor, (tx) =>
      this.audit.record(tx, {
        action: 'portal_access.requested',
        entityType: ENTITY_TYPE,
        entityId: customerId,
        meta: { contactId },
      }),
    );
  }

  async linkOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }> {
    return withTx(this.db, scope, actor, async (tx) => {
      // Both unique keys (tenant + party, and the ZITADEL org id) may be the one a concurrent grant took.
      const [inserted] = await tx
        .insert(idpOrgs)
        .values({
          tenantId: scope.tenantId,
          zitadelOrgId: i.zitadelOrgId,
          kind: 'customer',
          partyId: i.partyId,
          name: i.name,
        })
        .onConflictDoNothing()
        .returning({ id: idpOrgs.id });
      if (inserted) {
        await this.audit.record(tx, {
          action: 'portal_access.org_linked',
          entityType: ENTITY_TYPE,
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
          if (
            !PORTAL_ROLES.every((r) => roles.includes(r)) ||
            roles.length !== PORTAL_ROLES.length
          ) {
            await this.users.replaceRoles(q, scope, userId, PORTAL_ROLES);
            await this.users.bumpAuthzVersion(q, scope);
          }
          for (const step of i.steps) {
            await this.audit.record(q, {
              action: step.action,
              entityType: ENTITY_TYPE,
              entityId: i.customerId,
              meta: { contactId: i.contactId, ...step.meta },
            });
          }
          const response: PortalAccessDto = {
            customerId: i.customerId,
            contactId: i.contactId,
            userId,
            idpOrgId: i.idpOrgId,
            email: i.email,
            status: existing?.status ?? 'invited',
            inviteSent: i.inviteSent,
          };
          await this.audit.record(q, {
            action: 'portal_access.granted',
            entityType: ENTITY_TYPE,
            entityId: i.customerId,
            meta: { contactId: i.contactId, userId, idpOrgId: i.idpOrgId, created: !existing },
          });
          return { status: 201, response };
        },
      ),
    );
  }
}
