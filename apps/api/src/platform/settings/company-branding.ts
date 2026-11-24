// The company's name and logo as a screen or an email may show them (R6Q20). One place decides what of `entity.profile`
// leaves the profile: the display name and the primary logo's document id, nothing else. A profile that does not
// validate (a row edited by hand) gives no name and no logo, so a bad row never breaks a page or an email.
import { type Branding, CompanyProfileSchema } from '@bos/contracts';

import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { readSetting } from './settings.service';

export function brandingFromProfile(tenantId: string, rawProfile: unknown): Branding {
  const profile = CompanyProfileSchema.safeParse(rawProfile);
  if (!profile.success) return { displayName: null, logo: null };
  const { displayName, logoDocumentId } = profile.data;
  return {
    displayName: displayName?.trim() ? displayName.trim() : null,
    logo: logoDocumentId === null ? null : { tenantId, documentId: logoDocumentId },
  };
}

/**
 * The tenant's default entity and the profile it has saved now. The company logo is the default entity's: the public
 * logo address names only the tenant, so every screen and email that decides "there is a logo" must read the same
 * entity the address serves, or a second entity would show the default one's logo (or a broken image).
 */
export async function readDefaultEntityProfile(
  q: Db | DbTransaction,
  tenantId: string,
): Promise<{ organizationId: string; profile: unknown } | null> {
  // Raw SQL like readSetting, so it runs on any executor (a pooled Db or a transaction) the same way.
  const result = await q.execute<{ id: string }>(
    sql`SELECT id FROM app.organizations WHERE tenant_id = ${tenantId}::uuid AND is_default LIMIT 1`,
  );
  const entity = result.rows[0];
  if (entity === undefined) return null;
  const { value } = await readSetting(q, { tenantId, organizationId: entity.id }, 'entity.profile');
  return { organizationId: entity.id, profile: value };
}

/**
 * The branding of the scope's entity: its display name, and the company logo (the default entity's, see
 * readDefaultEntityProfile). Plain reads on `q`.
 */
export async function readBranding(q: Db | DbTransaction, scope: TxScope): Promise<Branding> {
  const own = brandingFromProfile(
    scope.tenantId,
    (await readSetting(q, scope, 'entity.profile')).value,
  );
  const company = await readDefaultEntityProfile(q, scope.tenantId);
  const logo = company === null ? null : brandingFromProfile(scope.tenantId, company.profile).logo;
  return { displayName: own.displayName, logo };
}
