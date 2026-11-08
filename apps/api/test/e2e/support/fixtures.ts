// Seed data and small helpers for the approvals exit e2e. Seeds exactly what production seeds (the kernel
// rows from tools/seed-zitadel) plus the users ZITADEL would mirror, so the scenario runs on real data and
// not on test-only shortcuts (NFR "authorization is deny-by-default": an unseeded role table denies everyone).
import { randomUUID } from 'node:crypto';

import { organizations, tenants, userRoles, users } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { seedKernelRows } from '../../../../../tools/seed-zitadel/src/db-seed';
import { systemActor, withTx } from '../../../src/platform/db/tx';
import type { E2eContext } from '../global-setup';

export type PersonaKey = 'sales' | 'accountant' | 'finance' | 'management' | 'founder';

export interface Persona {
  /** The ZITADEL `sub` the token carries; `app.users.zitadel_user_id`. */
  sub: string;
  /** `app.users.id`: what approval steps, owners and notifications point at. */
  userId: string;
  email: string;
  /** Roles in the token (they drive @Can and the record checks). */
  tokenRoles: string[];
  /** Roles in `app.user_roles` (they drive the approver lookup and "who is told about a block"). */
  mirroredRoles: string[];
}

export interface ApprovalsWorld {
  personas: Record<PersonaKey, Persona>;
  /** A bos_app pool for read-only assertions straight against the database. */
  pool: Pool;
  close(): Promise<void>;
}

/**
 * The single accountant also holds `sales`: the default grants give approvers no memo.create, so this is the
 * only way for an accountant to author a memo. It is also what makes the blocked negative real: when that
 * person is the author, separation of duties removes the only accountant from step 1.
 */
const PERSONAS: Record<PersonaKey, { tokenRoles: string[]; mirroredRoles: string[] }> = {
  sales: { tokenRoles: ['sales'], mirroredRoles: ['sales'] },
  accountant: { tokenRoles: ['accountant'], mirroredRoles: ['accountant', 'sales'] },
  finance: { tokenRoles: ['finance'], mirroredRoles: ['finance'] },
  management: { tokenRoles: ['management'], mirroredRoles: ['management'] },
  founder: { tokenRoles: ['founder'], mirroredRoles: ['founder'] },
};

/**
 * Seeds role_permissions, the test_memo workflow and the INR peg (the production seed), then one active user
 * per persona in the staff org, with an email so the outbox has a recipient. Run it BEFORE the app boots, so
 * the first request already sees the bumped authz version.
 */
export async function seedApprovalsWorld(
  e2e: E2eContext,
  /**
   * Prefix of every `sub` and email. `users.zitadel_user_id` is unique across tenants, so a second world
   * (see {@link createIsolatedStaffOrg}) needs its own prefix. The default is what the approvals e2e uses.
   */
  idPrefix = 'e2e-approvals',
): Promise<ApprovalsWorld> {
  const pool = new Pool({ connectionString: e2e.databaseUrl, max: 2 });
  const scope = { tenantId: e2e.tenantId, organizationId: e2e.staff.organizationId };

  // seedKernelRows runs its own BEGIN/COMMIT, so it needs one dedicated connection, not the pool.
  const client = await pool.connect();
  try {
    await seedKernelRows(client, { ...scope, correlationId: 'e2e-approvals-seed' });
  } finally {
    client.release();
  }

  const personas = {} as Record<PersonaKey, Persona>;
  const db = drizzle({ client: pool });
  await withTx(db, scope, systemActor('e2e-approvals-seed'), async (tx) => {
    for (const [key, roles] of Object.entries(PERSONAS) as [PersonaKey, typeof PERSONAS.sales][]) {
      const sub = `${idPrefix}-${key}`;
      const email = `${key}@${idPrefix}.test`;
      const [row] = await tx
        .insert(users)
        .values({
          ...scope,
          zitadelUserId: sub,
          email,
          displayName: `E2E ${key}`,
          status: 'active',
        })
        .returning({ id: users.id });
      if (row === undefined) throw new Error(`user insert for ${key} returned no row`);
      for (const roleKey of roles.mirroredRoles) {
        await tx.insert(userRoles).values({ ...scope, userId: row.id, roleKey, source: 'zitadel' });
      }
      personas[key] = { sub, userId: row.id, email, ...roles };
    }
  });

  return { personas, pool, close: () => pool.end() };
}

/**
 * A new tenant with one staff organization, for an e2e that seeds its own approvers. The role-based
 * approver lookup counts every user holding a role in the org, so a file that adds a second accountant to
 * the shared staff org would change who the approvals e2e sees as eligible. Spread the result over the
 * context: `seedApprovalsWorld({ ...e2e, ...isolated }, prefix)`, and mint tokens for `isolated.staff`.
 */
export async function createIsolatedStaffOrg(
  e2e: E2eContext,
  zitadelOrgId: string,
): Promise<Pick<E2eContext, 'tenantId' | 'staff'>> {
  // One connection, so the session-level seed actor (the audit trigger refuses writes with none) covers
  // both inserts. Same as global-setup.
  const pool = new Pool({ connectionString: e2e.databaseUrl, max: 1 });
  try {
    await pool.query(
      "SELECT set_config('bos.actor_kind', 'seed', false), set_config('bos.actor_id', 'seed:e2e-isolated-org', false), set_config('bos.correlation_id', 'e2e-isolated-org', false)",
    );
    const db = drizzle({ client: pool });
    const [tenant] = await db.insert(tenants).values({}).returning({ id: tenants.id });
    if (tenant === undefined) throw new Error('tenant insert returned no row');
    const organizationId = randomUUID();
    await db.insert(organizations).values({
      id: organizationId,
      tenantId: tenant.id,
      organizationId,
      kind: 'staff',
      name: 'Techrida (e2e isolated staff)',
      zitadelOrgId,
    });
    return { tenantId: tenant.id, staff: { organizationId, zitadelOrgId } };
  } finally {
    await pool.end();
  }
}

/** A minimal but well-formed one-page PDF (header, catalog, pages, page, xref with real offsets, trailer). */
export function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Calls `probe` until it returns a value (not undefined) or the timeout passes. On timeout the error carries
 * the last observation, so a stuck scan or drain says where it stopped instead of just "timed out".
 */
export async function pollUntil<T>(
  what: string,
  probe: () => Promise<{ done: T | undefined; last: unknown }>,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const r = await probe();
    if (r.done !== undefined) return r.done;
    last = r.last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(last)}`,
  );
}
