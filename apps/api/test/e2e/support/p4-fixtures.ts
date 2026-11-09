// Journey 11 prerequisites only. Business commands, uploads, scans, approvals and ledger posting run through
// the real API/worker in p4-exit. Approved vendor masters stand in for the separately tested KYB journey;
// portal identities stand in for ZITADEL provisioning, as in the P2 exit fixture.
import {
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  departments,
  userRoles,
  vendorAccounts,
  vendors,
} from '@bos/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { systemActor, withTx } from '../../../src/platform/db/tx';
import type { E2eContext } from '../global-setup';
import {
  createIsolatedStaffOrg,
  seedApprovalsWorld,
  type Persona,
  type PortalLogin,
} from './fixtures';

const EXTRA_ROLES = {
  requester: ['operations_officer'],
  procurement: ['procurement', 'accountant'],
  enterer: ['accountant', 'finance'],
  paymentRequester: ['finance'],
  paymentApprover: ['finance'],
  warehouse: ['warehouse'],
} as const;

export async function seedP4World(e2e: E2eContext) {
  const isolated = await createIsolatedStaffOrg(e2e);
  const approvals = await seedApprovalsWorld({ ...e2e, ...isolated }, 'e2e-p4-exit');
  const { pool } = approvals;
  try {
    const scope = { tenantId: isolated.tenantId, organizationId: isolated.staff.organizationId };
    const extra = {} as Record<keyof typeof EXTRA_ROLES, Persona>;
    for (const key of Object.keys(EXTRA_ROLES) as (keyof typeof EXTRA_ROLES)[]) {
      const roles = [...EXTRA_ROLES[key]];
      const { userId } = await createStaffUser(pool, {
        ...scope,
        idpOrgId: isolated.staff.idpOrgId,
        roleKeys: roles,
      });
      const { rows } = await pool.query<{ zitadel_user_id: string; email: string }>(
        'SELECT zitadel_user_id, email FROM app.users WHERE id = $1',
        [userId],
      );
      if (!rows[0]) throw new Error(`P4 persona ${key} was not seeded`);
      extra[key] = {
        userId,
        sub: rows[0].zitadel_user_id,
        email: rows[0].email,
        tokenRoles: roles,
        mirroredRoles: roles,
      };
    }
    // The bill's accountant can act as Finance too. Payment refusal therefore proves cross-document
    // separation of duties rather than merely a missing Finance role.
    const db = drizzle({ client: pool });
    const { departmentId } = await createDepartment(pool, { ...scope, name: 'Journey 11 IT' });
    await withTx(db, scope, systemActor('e2e-p4-exit-seed'), async (tx) => {
      await tx.insert(userRoles).values({
        tenantId: scope.tenantId,
        userId: approvals.personas.accountant.userId,
        roleKey: 'finance',
        source: 'zitadel',
      });
      await tx
        .update(departments)
        .set({ headUserId: approvals.personas.management.userId })
        .where(eq(departments.id, departmentId));
    });
    approvals.personas.accountant = {
      ...approvals.personas.accountant,
      tokenRoles: [...approvals.personas.accountant.tokenRoles, 'finance'],
      mirroredRoles: [...approvals.personas.accountant.mirroredRoles, 'finance'],
    };

    const vendorWorld: { id: string; login: PortalLogin }[] = [];
    for (let n = 0; n < 3; n++) {
      const party = await createParty(pool, { tenantId: scope.tenantId, kind: 'vendor' });
      await withTx(db, scope, systemActor('e2e-p4-exit-seed'), async (tx) => {
        await tx.insert(vendors).values({
          tenantId: scope.tenantId,
          id: party.partyId,
          legalName: `Journey 11 vendor ${n + 1}`,
          pan: `91000000${n + 1}`,
          vatRegistered: true,
          status: 'approved',
          ownerUserId: extra.procurement.userId,
          createdBy: extra.procurement.userId,
          approvedBy: approvals.personas.founder.userId,
        });
        await tx.insert(vendorAccounts).values({
          ...scope,
          vendorId: party.partyId,
          defaultCurrency: 'NPR',
          active: true,
        });
      });
      const { userId } = await createPortalUser(pool, {
        tenantId: scope.tenantId,
        idpOrgId: party.idpOrgId,
      });
      const { rows } = await pool.query<{ zitadel_user_id: string; zitadel_org_id: string }>(
        `SELECT u.zitadel_user_id, o.zitadel_org_id FROM app.users u
           JOIN app.idp_orgs o ON o.id = u.idp_org_id AND o.tenant_id = u.tenant_id
          WHERE u.id = $1`,
        [userId],
      );
      if (!rows[0]) throw new Error(`P4 vendor login ${n} was not seeded`);
      vendorWorld.push({
        id: party.partyId,
        login: {
          userId,
          idpOrgId: party.idpOrgId,
          sub: rows[0].zitadel_user_id,
          zitadelOrgId: rows[0].zitadel_org_id,
        },
      });
    }
    return {
      ...isolated,
      ...approvals,
      scope,
      departmentId,
      personas: { ...approvals.personas, ...extra },
      vendors: vendorWorld,
    };
  } catch (error) {
    await approvals.close();
    throw error;
  }
}

export type P4World = Awaited<ReturnType<typeof seedP4World>>;
export type P4PersonaKey = keyof P4World['personas'];
