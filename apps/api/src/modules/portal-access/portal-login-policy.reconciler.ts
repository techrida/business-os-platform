// Portal login policy reconcile (worker only): once, when the worker boots, it pins PORTAL_LOGIN_POLICY (registration
// off, MFA forced and never skippable) on the ZITADEL org of every existing customer. Serves D23 = C. The grant path
// (PortalAccessService) pins the policy on every grant, so orgs granted after that change are fine, but an org created
// before it only gets fixed on its next grant, which may never come. This closes that gap without waiting for a grant.
//
// Safe to repeat and to run on two workers at once: ensureOrgLoginPolicy reads the org's policy first and writes only
// when it differs, so a second run (or a second worker) finds every org 'unchanged' and writes nothing. It uses the
// same ZitadelAdminClient and credential as the grant path: no new credential, no way around authorization.
//
// Per org: the default legal entity of its tenant is looked up first (the audit row needs an entity scope). An org
// whose tenant has none is logged and skipped before ZITADEL is called. A change ('created' or 'updated') gets one
// audit row, written in a transaction under the system actor `system:portal-login-policy`; 'unchanged' gets none.
// There is no transaction across ZITADEL and our database: if the audit write fails after ZITADEL changed the org,
// the next run sees 'unchanged' and that audit row is lost. Accepted: the policy is what matters, and the row only
// records that the job pinned it.
//
// A ZitadelNotConfiguredError (no provisioner token, as in a local dev worker) stops the run with one warning.
// Any other failure is logged for that org (its id and the error name only, since a message can carry ZITADEL
// detail) and the run goes on.
//
// Not a queue job: it runs on OnApplicationBootstrap and is not awaited, so a slow ZITADEL never delays boot. The
// tests drive the reconciler through a store fake; the drizzle store below is for an integration test.
import { idpOrgs, organizations } from '@bos/db';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

import type { AuditService } from '../../platform/audit/audit.service';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import { type Actor, systemActor, type TxScope } from '../../platform/db/tx';
import {
  PORTAL_LOGIN_POLICY,
  type ZitadelAdminClient,
  ZitadelNotConfiguredError,
} from '../../platform/users/zitadel-admin.client';

/** The job name after the `system:` prefix of the actor id; the audit log shows `system:portal-login-policy`. */
export const PORTAL_LOGIN_POLICY_JOB = 'portal-login-policy';

export const LOGIN_POLICY_STORE = Symbol('PORTAL_LOGIN_POLICY_STORE');
export const LOGIN_POLICY_TX = Symbol('PORTAL_LOGIN_POLICY_TX');
export const LOGIN_POLICY_AUDIT = Symbol('PORTAL_LOGIN_POLICY_AUDIT');
export const LOGIN_POLICY_ZITADEL = Symbol('PORTAL_LOGIN_POLICY_ZITADEL');

/** A customer's ZITADEL org as app.idp_orgs maps it. */
export interface CustomerIdpOrg {
  tenantId: string;
  zitadelOrgId: string;
  /** The customer party the org belongs to (the audit entity id). */
  partyId: string;
}

/** The job's database access, as a port. Both reads run on the plain pool, across tenants. */
export interface LoginPolicyStore {
  /** Every customer org of every tenant, oldest first. */
  customerOrgs(): Promise<CustomerIdpOrg[]>;
  /** The tenant's default legal entity, or null when it has none. */
  defaultEntityOf(tenantId: string): Promise<string | null>;
}

export type RunInTx = <T>(
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;
export type LoginPolicyAudit = Pick<AuditService, 'record'>;
export type LoginPolicyZitadel = Pick<ZitadelAdminClient, 'ensureOrgLoginPolicy'>;

export interface ReconcileResult {
  /** Orgs ZITADEL created or updated a policy on (each audited). */
  changed: number;
  /** Orgs that already had the policy. */
  unchanged: number;
  /** Orgs left alone because their tenant has no default entity. */
  skipped: number;
  /** Orgs whose ZITADEL call or audit write failed. */
  failed: number;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'error');

@Injectable()
export class PortalLoginPolicyReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PortalLoginPolicyReconciler.name);

  constructor(
    @Inject(LOGIN_POLICY_STORE) private readonly store: LoginPolicyStore,
    @Inject(LOGIN_POLICY_TX) private readonly runTx: RunInTx,
    @Inject(LOGIN_POLICY_AUDIT) private readonly audit: LoginPolicyAudit,
    @Inject(LOGIN_POLICY_ZITADEL) private readonly zitadel: LoginPolicyZitadel,
  ) {}

  /** Starts the run and returns at once: boot never waits for ZITADEL, and a failed run never crashes the worker. */
  onApplicationBootstrap(): void {
    void this.reconcile().catch((error: unknown) => {
      this.logger.error(`portal login policy reconcile failed: kind=${errorName(error)}`);
    });
  }

  /** One run over every customer org. An org that fails is logged and left for the next boot; the rest go on. */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { changed: 0, unchanged: 0, skipped: 0, failed: 0 };
    const defaults = new Map<string, string | null>();
    for (const org of await this.store.customerOrgs()) {
      try {
        let entityId = defaults.get(org.tenantId);
        if (entityId === undefined) {
          entityId = await this.store.defaultEntityOf(org.tenantId);
          defaults.set(org.tenantId, entityId);
        }
        if (entityId === null) {
          result.skipped += 1;
          this.logger.warn(
            `portal login policy skipped, tenant has no default entity: org=${org.zitadelOrgId}`,
          );
          continue;
        }

        const policy = await this.zitadel.ensureOrgLoginPolicy(
          org.zitadelOrgId,
          PORTAL_LOGIN_POLICY,
        );
        if (policy === 'unchanged') {
          result.unchanged += 1;
          continue;
        }
        const scope: TxScope = { tenantId: org.tenantId, organizationId: entityId };
        await this.runTx(scope, systemActor(PORTAL_LOGIN_POLICY_JOB), (tx) =>
          this.audit.record(tx, {
            action: 'portal_access.login_policy_pinned',
            entityType: 'customer',
            entityId: org.partyId,
            meta: { zitadelOrgId: org.zitadelOrgId, result: policy, source: 'reconcile' },
          }),
        );
        result.changed += 1;
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn('portal login policy reconcile stopped: ZITADEL is not configured');
          break;
        }
        result.failed += 1;
        this.logger.error(
          `portal login policy failed: org=${org.zitadelOrgId} kind=${errorName(error)}`,
        );
      }
    }
    this.logger.log(
      `portal login policy reconcile done: changed=${result.changed} unchanged=${result.unchanged} skipped=${result.skipped} failed=${result.failed}`,
    );
    return result;
  }
}

/**
 * The store on the real tables, on the plain pool like UsersStore.listStaffIdpOrgs and defaultEntityOf: the read
 * crosses tenants on purpose (the job has no request and no tenant), and it writes nothing.
 */
export function drizzleLoginPolicyStore(db: Db): LoginPolicyStore {
  return {
    async customerOrgs() {
      const rows = await db
        .select({
          tenantId: idpOrgs.tenantId,
          zitadelOrgId: idpOrgs.zitadelOrgId,
          partyId: idpOrgs.partyId,
        })
        .from(idpOrgs)
        // idp_orgs_party_check makes party_id non-null for a customer; the filter only narrows the type.
        .where(and(eq(idpOrgs.kind, 'customer'), isNotNull(idpOrgs.partyId)))
        .orderBy(asc(idpOrgs.createdAt), asc(idpOrgs.id));
      return rows.flatMap((r) => (r.partyId === null ? [] : [{ ...r, partyId: r.partyId }]));
    },

    async defaultEntityOf(tenantId) {
      const [found] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.tenantId, tenantId), eq(organizations.isDefault, true)))
        .limit(1);
      return found?.id ?? null;
    },
  };
}
