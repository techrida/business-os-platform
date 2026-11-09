// K4: the boot-time login policy reconcile covers vendor portal orgs as well as customer ones (closed registration,
// D11), and audits each change against the party of its own kind. The SQL filter that returns both kinds is checked
// against a real database in vendor-portal-access.integration.test.ts.
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../platform/db/db.module';
import { PORTAL_LOGIN_POLICY } from '../../platform/users/zitadel-admin.client';
import {
  PortalLoginPolicyReconciler,
  type CustomerIdpOrg,
  type LoginPolicyStore,
  type RunInTx,
} from './portal-login-policy.reconciler';

const TX = { marker: 'tx' } as unknown as DbTransaction;

describe('PortalLoginPolicyReconciler with vendor orgs', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the policy on a vendor org and audits it against the vendor', async () => {
    const orgs: CustomerIdpOrg[] = [
      { tenantId: 'tenant-1', zitadelOrgId: 'zorg-c', partyId: 'party-c', kind: 'customer' },
      { tenantId: 'tenant-1', zitadelOrgId: 'zorg-v', partyId: 'party-v', kind: 'vendor' },
    ];
    const store: LoginPolicyStore = {
      customerOrgs: () => Promise.resolve(orgs),
      defaultEntityOf: () => Promise.resolve('entity-1'),
    };
    const zitadel = { ensureOrgLoginPolicy: vi.fn(() => Promise.resolve('created' as const)) };
    const audit = { record: vi.fn((_tx: DbTransaction, _input: unknown) => Promise.resolve()) };
    const runTx: RunInTx = (_scope, _actor, fn) => fn(TX);
    const reconciler = new PortalLoginPolicyReconciler(store, runTx, audit, zitadel);

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 2, unchanged: 0, skipped: 0, failed: 0 });
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledWith('zorg-v', PORTAL_LOGIN_POLICY);
    expect(PORTAL_LOGIN_POLICY).toMatchObject({ allowRegister: false });
    expect(audit.record.mock.calls.map(([, input]) => input)).toEqual([
      {
        action: 'portal_access.login_policy_pinned',
        entityType: 'customer',
        entityId: 'party-c',
        meta: { zitadelOrgId: 'zorg-c', result: 'created', source: 'reconcile' },
      },
      {
        action: 'portal_access.login_policy_pinned',
        entityType: 'vendor',
        entityId: 'party-v',
        meta: { zitadelOrgId: 'zorg-v', result: 'created', source: 'reconcile' },
      },
    ]);
  });
});
