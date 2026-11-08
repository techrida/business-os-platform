import type { OrgKind } from '@bos/contracts';
import { idpOrgs, organizations } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module';

/**
 * What the rest of the API needs to know about the caller's IdP org (a ZITADEL organization, ADR
 * 0027 §2) and the tenant behind it.
 */
export interface ResolvedIdpOrg {
  /** `app.idp_orgs.id`. */
  idpOrgId: string;
  tenantId: string;
  kind: OrgKind;
  /** The customer or vendor party behind a portal org; null for the staff org. */
  partyId: string | null;
  /** Every legal entity (`app.organizations.id`) of the tenant. */
  entityIds: readonly string[];
  /** The tenant's default entity, or null when none is marked. */
  defaultEntityId: string | null;
}

/** Milliseconds since the epoch. Injected so tests can move time without real waiting. */
export type Clock = () => number;
export const CLOCK = Symbol('TENANCY_CLOCK');

/**
 * How long a lookup is reused. A removed org, or an entity added or removed, takes at most this long
 * to be noticed.
 */
export const IDP_ORG_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  org: ResolvedIdpOrg;
  expiresAt: number;
}

/**
 * Maps the ZITADEL org id from a verified token to its `idp_orgs` row, and loads the tenant's legal
 * entities with it (ADR 0027 §4 step 1).
 *
 * Every authenticated request needs this, so results are cached in memory for 60 s. Only hits are
 * cached: an unknown org is looked up again each time, so an org that is seeded a moment after the
 * first failed call works immediately. The cache cannot grow without bound because keys come from
 * tokens that already passed signature checks, and the table holds few rows.
 */
@Injectable()
export class IdpOrgResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async resolve(zitadelOrgId: string): Promise<ResolvedIdpOrg> {
    const now = this.now();
    const cached = this.cache.get(zitadelOrgId);
    if (cached && cached.expiresAt > now) {
      return cached.org;
    }

    const rows = await this.db
      .select({
        idpOrgId: idpOrgs.id,
        tenantId: idpOrgs.tenantId,
        kind: idpOrgs.kind,
        partyId: idpOrgs.partyId,
      })
      .from(idpOrgs)
      .where(eq(idpOrgs.zitadelOrgId, zitadelOrgId))
      .limit(1);

    const idp = rows[0];
    if (!idp) {
      this.cache.delete(zitadelOrgId);
      // The message names no org id: the caller is authenticated but must learn nothing about which orgs exist.
      throw new ForbiddenException('Organization is not registered');
    }

    const entities = await this.db
      .select({ id: organizations.id, isDefault: organizations.isDefault })
      .from(organizations)
      .where(eq(organizations.tenantId, idp.tenantId));

    const org: ResolvedIdpOrg = {
      ...idp,
      entityIds: Object.freeze(entities.map((e) => e.id)),
      defaultEntityId: entities.find((e) => e.isDefault)?.id ?? null,
    };
    // Stamp expiry from the time the lookup finished, not started, so a slow query is not cut short.
    this.cache.set(zitadelOrgId, { org, expiresAt: this.now() + IDP_ORG_CACHE_TTL_MS });
    return org;
  }
}
