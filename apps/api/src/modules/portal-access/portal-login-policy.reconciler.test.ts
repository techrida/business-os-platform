import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import {
  PORTAL_LOGIN_POLICY,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
} from '../../platform/users/zitadel-admin.client';
import {
  PORTAL_LOGIN_POLICY_JOB,
  PortalLoginPolicyReconciler,
  type CustomerIdpOrg,
  type LoginPolicyStore,
  type RunInTx,
} from './portal-login-policy.reconciler';

const TX = { marker: 'tx' } as unknown as DbTransaction;

const org = (n: number, over: Partial<CustomerIdpOrg> = {}): CustomerIdpOrg => ({
  tenantId: 'tenant-1',
  zitadelOrgId: `zorg-${n}`,
  partyId: `party-${n}`,
  ...over,
});

type PolicyResult = 'created' | 'updated' | 'unchanged' | Error;

function setup(
  opts: {
    orgs?: CustomerIdpOrg[];
    /** What ensureOrgLoginPolicy answers per ZITADEL org id; a missing key means 'unchanged'. */
    policies?: Record<string, PolicyResult>;
    /** The default entity per tenant; a missing tenant has one, `null` means none. */
    entities?: Record<string, string | null>;
    auditError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const scopes: Array<{ scope: TxScope; actor: Actor }> = [];
  const policies = opts.policies ?? {};
  const entities = opts.entities ?? {};
  const store: LoginPolicyStore = {
    customerOrgs: vi.fn(() => Promise.resolve(opts.orgs ?? [])),
    defaultEntityOf: vi.fn((tenantId: string) => {
      calls.push(`defaultEntityOf:${tenantId}`);
      return Promise.resolve(tenantId in entities ? (entities[tenantId] ?? null) : 'entity-1');
    }),
  };
  const zitadel = {
    ensureOrgLoginPolicy: vi.fn((zitadelOrgId: string) => {
      calls.push(`ensure:${zitadelOrgId}`);
      const result = zitadelOrgId in policies ? policies[zitadelOrgId] : 'unchanged';
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result as 'created' | 'updated' | 'unchanged');
    }),
  };
  const audit = {
    record: vi.fn((_tx: DbTransaction, _input: unknown) => {
      calls.push('audit');
      return opts.auditError ? Promise.reject(opts.auditError) : Promise.resolve();
    }),
  };
  const runTx: RunInTx = (scope, actor, fn) => {
    scopes.push({ scope, actor });
    return fn(TX);
  };
  const reconciler = new PortalLoginPolicyReconciler(store, runTx, audit, zitadel);
  return { reconciler, store, zitadel, audit, calls, scopes };
}

describe('PortalLoginPolicyReconciler', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the portal policy on the org and audits a change under the system actor', async () => {
    const { reconciler, zitadel, audit, scopes } = setup({
      orgs: [org(1), org(2)],
      policies: { 'zorg-1': 'created', 'zorg-2': 'updated' },
    });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 2, unchanged: 0, skipped: 0, failed: 0 });
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledWith('zorg-1', PORTAL_LOGIN_POLICY);
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledWith('zorg-2', PORTAL_LOGIN_POLICY);
    expect(audit.record.mock.calls).toEqual([
      [
        TX,
        {
          action: 'portal_access.login_policy_pinned',
          entityType: 'customer',
          entityId: 'party-1',
          meta: { zitadelOrgId: 'zorg-1', result: 'created', source: 'reconcile' },
        },
      ],
      [
        TX,
        {
          action: 'portal_access.login_policy_pinned',
          entityType: 'customer',
          entityId: 'party-2',
          meta: { zitadelOrgId: 'zorg-2', result: 'updated', source: 'reconcile' },
        },
      ],
    ]);
    expect(scopes).toHaveLength(2);
    for (const { scope, actor } of scopes) {
      expect(scope).toEqual({ tenantId: 'tenant-1', organizationId: 'entity-1' });
      expect(actor.kind).toBe('system');
      expect(actor.id).toBe(`system:${PORTAL_LOGIN_POLICY_JOB}`);
    }
  });

  it('writes no audit row and opens no transaction for an org that is already pinned', async () => {
    const { reconciler, audit, scopes } = setup({ orgs: [org(1)] });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 0, unchanged: 1, skipped: 0, failed: 0 });
    expect(audit.record).not.toHaveBeenCalled();
    expect(scopes).toHaveLength(0);
  });

  it('keeps going after an org fails, and logs only its id and the error name', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const { reconciler, calls, audit } = setup({
      orgs: [org(1), org(2), org(3)],
      policies: {
        'zorg-1': 'updated',
        'zorg-2': new ZitadelHttpError('/management/v1/policies/login', 500, 'secret detail'),
        'zorg-3': 'created',
      },
    });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 2, unchanged: 0, skipped: 0, failed: 1 });
    expect(calls.filter((c) => c.startsWith('ensure:'))).toEqual([
      'ensure:zorg-1',
      'ensure:zorg-2',
      'ensure:zorg-3',
    ]);
    expect(audit.record).toHaveBeenCalledTimes(2);
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('zorg-2');
    expect(logged).toContain('ZitadelHttpError');
    expect(logged).not.toContain('secret detail');
  });

  it('counts an org as failed when its audit write fails, and goes on', async () => {
    const { reconciler, zitadel } = setup({
      orgs: [org(1), org(2)],
      policies: { 'zorg-1': 'created', 'zorg-2': 'created' },
      auditError: new Error('audit down'),
    });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 0, unchanged: 0, skipped: 0, failed: 2 });
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledTimes(2);
  });

  it('stops the whole run with one warning when ZITADEL is not configured', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { reconciler, zitadel, audit } = setup({
      orgs: [org(1), org(2), org(3)],
      policies: { 'zorg-1': new ZitadelNotConfiguredError() },
    });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 0, unchanged: 0, skipped: 0, failed: 0 });
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips an org whose tenant has no default entity without calling ZITADEL', async () => {
    const { reconciler, zitadel, store, audit } = setup({
      orgs: [org(1, { tenantId: 'tenant-empty' }), org(2, { tenantId: 'tenant-empty' }), org(3)],
      entities: { 'tenant-empty': null },
      policies: { 'zorg-3': 'updated' },
    });

    const result = await reconciler.reconcile();

    expect(result).toEqual({ changed: 1, unchanged: 0, skipped: 2, failed: 0 });
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledTimes(1);
    expect(zitadel.ensureOrgLoginPolicy).toHaveBeenCalledWith('zorg-3', PORTAL_LOGIN_POLICY);
    expect(audit.record).toHaveBeenCalledTimes(1);
    // One lookup per tenant per run, not per org.
    expect(store.defaultEntityOf).toHaveBeenCalledTimes(2);
  });

  it('does not block boot: onApplicationBootstrap returns at once and a failed run is caught', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const { reconciler, store } = setup();
    let release: () => void = () => undefined;
    store.customerOrgs = vi.fn(
      () =>
        new Promise<CustomerIdpOrg[]>((_resolve, reject) => {
          release = () => reject(new Error('db down'));
        }),
    );

    expect(reconciler.onApplicationBootstrap()).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(String(error.mock.calls[0]?.[0])).toContain('Error');
  });
});
