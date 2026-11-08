// Seed data and small helpers for the approvals exit e2e. Seeds exactly what production seeds (the kernel
// rows from tools/seed-zitadel) plus the users ZITADEL would mirror, so the scenario runs on real data and
// not on test-only shortcuts (NFR "authorization is deny-by-default": an unseeded role table denies everyone).
import { userRoles, users } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { seedKernelRows } from '../../../../../tools/seed-zitadel/src/db-seed';
import { systemActor, withTx } from '../../../src/platform/db/tx';
import type { E2eContext } from '../global-setup';

export type PersonaKey = 'sales' | 'accountant' | 'finance' | 'founder';

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
  founder: { tokenRoles: ['founder'], mirroredRoles: ['founder'] },
};

/**
 * Seeds role_permissions, the test_memo workflow and the INR peg (the production seed), then one active user
 * per persona in the staff org, with an email so the outbox has a recipient. Run it BEFORE the app boots, so
 * the first request already sees the bumped authz version.
 */
export async function seedApprovalsWorld(e2e: E2eContext): Promise<ApprovalsWorld> {
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
      const sub = `e2e-approvals-${key}`;
      const email = `${key}@e2e-approvals.test`;
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
