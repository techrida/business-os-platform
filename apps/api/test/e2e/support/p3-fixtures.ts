// Seed data for the P3 exit e2e (and the model test). It builds on the approvals world (support/fixtures.ts: the
// production seed plus one user per persona) in a tenant of its own, and adds the two staff users P3's separation of
// duties needs on top of it:
// - `preparer` holds the accountant role. They confirm the sales order, mark lines billable, and draft and submit the
//   invoices. As the drafter they are removed from the accountant step, so the `accountant` persona decides it.
//   Without a second accountant the router refuses the route (no distinct approver per step: 422).
// - `finance2` holds the finance role. They draft the credit note (only finance holds `invoice.credit_note`), and
//   verify and allocate the customer's payment: "a different Finance user" from the one who issued the invoices.
//
// Own tenant (createIsolatedStaffOrg), as in p2-exit: the approver lookup counts every holder of a role in a tenant,
// so the extra accountant and finance users must not leak into another e2e file's approver set.
import { randomUUID } from 'node:crypto';

import { documents, documentVersions, userEntities, userRoles, users } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';

import { systemActor, withTx } from '../../../src/platform/db/tx';
import type { E2eContext } from '../global-setup';
import {
  createIsolatedStaffOrg,
  seedApprovalsWorld,
  type ApprovalsWorld,
  type Persona,
  type PersonaKey,
} from './fixtures';

export type P3PersonaKey = PersonaKey | 'preparer' | 'finance2';

export interface P3World {
  /** The isolated tenant and its staff org: mint every staff token for `isolated.staff`. */
  isolated: Pick<E2eContext, 'tenantId' | 'staff'>;
  scope: { tenantId: string; organizationId: string };
  personas: Record<P3PersonaKey, Persona>;
  /** A bos_app pool for read-only assertions and the declared seed shortcuts. */
  pool: ApprovalsWorld['pool'];
  close(): Promise<void>;
}

const EXTRA: Record<'preparer' | 'finance2', { tokenRoles: string[]; mirroredRoles: string[] }> = {
  preparer: { tokenRoles: ['accountant'], mirroredRoles: ['accountant'] },
  finance2: { tokenRoles: ['finance'], mirroredRoles: ['finance'] },
};

/**
 * A fresh tenant with the production seed, the five approvals personas and the two P3 extras. Run it BEFORE the app
 * boots, so the first request already sees the seeded authz version.
 */
export async function seedP3World(e2e: E2eContext, idPrefix: string): Promise<P3World> {
  const isolated = await createIsolatedStaffOrg(e2e);
  const world = await seedApprovalsWorld({ ...e2e, ...isolated }, idPrefix);
  const scope = { tenantId: isolated.tenantId, organizationId: isolated.staff.organizationId };

  const extras = {} as Record<'preparer' | 'finance2', Persona>;
  await withTx(
    drizzle({ client: world.pool }),
    scope,
    systemActor(`${idPrefix}-seed`),
    async (tx) => {
      for (const [key, roles] of Object.entries(EXTRA) as [
        keyof typeof EXTRA,
        typeof EXTRA.preparer,
      ][]) {
        const sub = `${idPrefix}-${key}`;
        const email = `${key}@${idPrefix}.test`;
        const [row] = await tx
          .insert(users)
          .values({
            tenantId: scope.tenantId,
            idpOrgId: isolated.staff.idpOrgId,
            zitadelUserId: sub,
            email,
            displayName: `E2E ${key}`,
            status: 'active',
          })
          .returning({ id: users.id });
        if (row === undefined) throw new Error(`user insert for ${key} returned no row`);
        await tx.insert(userEntities).values({ ...scope, userId: row.id, isDefault: true });
        for (const roleKey of roles.mirroredRoles) {
          await tx
            .insert(userRoles)
            .values({ tenantId: scope.tenantId, userId: row.id, roleKey, source: 'zitadel' });
        }
        extras[key] = { sub, userId: row.id, email, ...roles };
      }
    },
  );

  return {
    isolated,
    scope,
    personas: { ...world.personas, ...extras },
    pool: world.pool,
    close: () => world.close(),
  };
}

/**
 * A clean payment proof for `customerId`, as if `uploadedBy` had uploaded a bank slip through the staff proof route and
 * the scan had cleared it. A SHORTCUT, the same rows payments.integration.test.ts seeds (`proof()`): one document
 * owned by `payment_intake` / the customer and one `clean` version. It skips only the upload and the virus scan, which
 * p3-exit covers end to end; the payment routes still check every rule of the proof (entity, customer, clean, unused).
 */
export async function seedCleanProof(
  world: P3World,
  customerId: string,
  uploadedBy: string,
): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await withTx(
    drizzle({ client: world.pool }),
    world.scope,
    systemActor('e2e-p3-proof'),
    async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        ...world.scope,
        ownerType: 'payment_intake',
        ownerId: customerId,
        createdBy: uploadedBy,
      });
      await tx.insert(documentVersions).values({
        id: versionId,
        ...world.scope,
        documentId,
        version: 1,
        filename: 'slip.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 1000,
        storageKey: `${world.scope.tenantId}/${versionId}`,
        status: 'clean',
        uploadedBy,
      });
    },
  );
  return documentId;
}
