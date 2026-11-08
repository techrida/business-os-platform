import type { OrgKind } from '@bos/contracts';
import { organizations } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module';

/** What the rest of the API needs to know about the caller's organization. */
export interface ResolvedOrg {
  tenantId: string;
  organizationId: string;
  orgKind: OrgKind;
}

/** Milliseconds since the epoch. Injected so tests can move time without real waiting. */
export type Clock = () => number;
export const CLOCK = Symbol('TENANCY_CLOCK');

/** How long a lookup is reused. A renamed or removed org takes at most this long to be noticed. */
export const ORG_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  org: ResolvedOrg;
  expiresAt: number;
}

/**
 * Maps the ZITADEL org id from a verified token to our `organizations` row.
 *
 * Every authenticated request needs this, so results are cached in memory for 60 s. Only hits are
 * cached: an unknown org is looked up again each time, so an org that is seeded a moment after the
 * first failed call works immediately. The cache cannot grow without bound because keys come from
 * tokens that already passed signature checks, and the table holds few rows.
 */
@Injectable()
export class OrgResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async resolve(zitadelOrgId: string): Promise<ResolvedOrg> {
    const now = this.now();
    const cached = this.cache.get(zitadelOrgId);
    if (cached && cached.expiresAt > now) {
      return cached.org;
    }

    const rows = await this.db
      .select({
        tenantId: organizations.tenantId,
        organizationId: organizations.organizationId,
        orgKind: organizations.kind,
      })
      .from(organizations)
      .where(eq(organizations.zitadelOrgId, zitadelOrgId))
      .limit(1);

    const org = rows[0];
    if (!org) {
      this.cache.delete(zitadelOrgId);
      // The message names no org id: the caller is authenticated but must learn nothing about which orgs exist.
      throw new ForbiddenException('Organization is not registered');
    }

    // Stamp expiry from the time the lookup finished, not started, so a slow query is not cut short.
    this.cache.set(zitadelOrgId, { org, expiresAt: this.now() + ORG_CACHE_TTL_MS });
    return org;
  }
}
