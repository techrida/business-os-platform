import { DrizzleQueryError } from 'drizzle-orm/errors';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { principal } from '../authz/principal';
import { ctx } from '../tenancy/request-context';
import type { Db } from './db.module';
import { type Actor, type TxScope, requestTx, systemActor, withTx } from './tx';
import { type TxObserver, configureTx, setTxObserver } from './tx-settings';

vi.mock('../tenancy/request-context', () => ({ ctx: vi.fn() }));
vi.mock('../authz/principal', () => ({ principal: vi.fn() }));

const CORRELATION_ID = /^[A-Za-z0-9-]{8,64}$/;
const SETTINGS = [
  'bos.tenant_id',
  'bos.organization_id',
  'bos.actor_kind',
  'bos.actor_id',
  'bos.correlation_id',
  'bos.ip',
  'bos.user_agent',
];

/**
 * A db whose transaction behaves like Postgres for the one thing withTx relies on: a
 * `set_config(name, value, true)` call (is_local) lasts until COMMIT or ROLLBACK, a `false` one
 * outlives the transaction. It renders each statement with drizzle's real Postgres dialect, so the
 * test sees the text and the bound parameters the driver would send.
 */
function fakeDb() {
  /** `lockTimeout`: the lock_timeout in force when the statement started, as a lock wait would see it. */
  const executed: { text: string; params: unknown[]; lockTimeout: string | null }[] = [];
  const session = new Map<string, string>();
  let local = new Map<string, string>();
  const dialect = new PgDialect();

  const tx = {
    execute: (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      executed.push({ text, params, lockTimeout: local.get('lock_timeout') ?? null });
      for (const m of text.matchAll(/set_config\('([a-z_.]+)',\s*\$(\d+),\s*(true|false)\)/g)) {
        const [, name, index, isLocal] = m as unknown as [string, string, string, string];
        (isLocal === 'true' ? local : session).set(name, String(params[Number(index) - 1]));
      }
      return Promise.resolve({ rows: [] });
    },
    /** What `current_setting(name, true)` would return right now; null when unset. */
    setting: (name: string) => local.get(name) ?? session.get(name) ?? null,
  };

  const db = {
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      local = new Map();
      try {
        return await fn(tx);
      } finally {
        local = new Map(); // COMMIT and ROLLBACK both drop transaction-local settings
      }
    },
  };

  return { db: db as unknown as Db, tx, executed, setting: tx.setting };
}

const scope: TxScope = { tenantId: 'tenant-1', organizationId: 'org-1' };
const actor: Actor = {
  kind: 'user',
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  ip: '203.0.113.7',
  userAgent: 'vitest/1',
  correlationId: 'corr-12345678',
};

describe('withTx', () => {
  it('sets all seven bos.* settings in one first statement, visible inside fn and gone after commit', async () => {
    const { db, executed, setting } = fakeDb();
    let seenInside: Record<string, string | null> = {};

    const result = await withTx(db, scope, actor, () => {
      expect(executed).toHaveLength(2); // the settings, then the tenant audit lock
      expect(executed[0]?.text).toContain("set_config('bos.tenant_id'");
      seenInside = Object.fromEntries(SETTINGS.map((n) => [n, setting(n)]));
      return Promise.resolve('done');
    });

    expect(result).toBe('done');
    expect(seenInside).toEqual({
      'bos.tenant_id': 'tenant-1',
      'bos.organization_id': 'org-1',
      'bos.actor_kind': 'user',
      'bos.actor_id': '0f8fad5b-d9cb-469f-a165-70867728950e',
      'bos.correlation_id': 'corr-12345678',
      'bos.ip': '203.0.113.7',
      'bos.user_agent': 'vitest/1',
    });
    for (const name of SETTINGS) expect(setting(name)).toBeNull();
  });

  it('is one SELECT with the values bound as parameters, never spliced into the text', async () => {
    const { db, executed } = fakeDb();
    await withTx(db, scope, actor, () => Promise.resolve());

    expect(executed).toHaveLength(2);
    const [stmt] = executed;
    expect(stmt?.text.trimStart().startsWith('SELECT')).toBe(true);
    expect(stmt?.text.match(/set_config\(/g)).toHaveLength(10);
    expect(stmt?.text.match(/, true\)/g)).toHaveLength(10);
    expect(stmt?.text).not.toContain('tenant-1');
    expect(stmt?.params).toEqual([
      'tenant-1',
      'org-1',
      'user',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'corr-12345678',
      '203.0.113.7',
      'vitest/1',
      '5000ms',
      '15000ms',
      '30000ms',
    ]);
  });

  it('turns a null or missing ip and userAgent into an empty string', async () => {
    const { db, setting } = fakeDb();
    const seen: (string | null)[] = [];
    await withTx(db, scope, { ...actor, ip: null, userAgent: null }, () => {
      seen.push(setting('bos.ip'), setting('bos.user_agent'));
      return Promise.resolve();
    });
    const bare: Actor = { kind: 'user', id: actor.id, correlationId: actor.correlationId };
    await withTx(db, scope, bare, () => {
      seen.push(setting('bos.ip'), setting('bos.user_agent'));
      return Promise.resolve();
    });
    expect(seen).toEqual(['', '', '', '']);
  });

  it('propagates a rollback and leaves no setting behind', async () => {
    const { db, setting } = fakeDb();
    const boom = new Error('boom');
    let inside: string | null = null;

    await expect(
      withTx(db, scope, actor, () => {
        inside = setting('bos.actor_id');
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);

    expect(inside).toBe(actor.id);
    expect(setting('bos.actor_id')).toBeNull();
  });

  it.each([
    ['actor.id', { id: '' }],
    ['actor.id', { id: '   ' }],
    ['actor.correlationId', { correlationId: '' }],
  ])('rejects an empty %s before opening a transaction', async (what, override) => {
    const { db } = fakeDb();
    const transaction = vi.spyOn(db, 'transaction');
    const fn = vi.fn(() => Promise.resolve());

    await expect(withTx(db, scope, { ...actor, ...override }, fn)).rejects.toThrow(
      `${what} must be a non-empty string`,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withTx tenant audit lock', () => {
  // The exact lock audit.append takes (packages/db/migrations/0008_audit_hardening.sql), keyed on the uuid as text.
  const LOCK =
    "SELECT pg_advisory_xact_lock(hashtextextended('audit.chain:' || $1::uuid::text, 0))";
  const TENANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it.each([
    ['by default', undefined],
    ["with audit: 'first'", { audit: 'first' as const }],
  ])('%s takes the lock after the settings and before fn runs', async (_, options) => {
    const { db, executed } = fakeDb();
    let seenInside: typeof executed = [];

    await withTx(
      db,
      { ...scope, tenantId: TENANT },
      actor,
      () => {
        seenInside = [...executed];
        return Promise.resolve();
      },
      options,
    );

    expect(seenInside).toHaveLength(2);
    expect(seenInside[0]?.text).toContain('set_config(');
    // The wait is already bounded by lock_timeout, so a long holder ends in 55P03, not a stuck connection.
    expect(seenInside[1]).toEqual({ text: LOCK, params: [TENANT], lockTimeout: '5000ms' });
  });

  it("with audit: 'lazy' takes no lock: only the settings statement runs before fn", async () => {
    const { db, executed } = fakeDb();
    let seenInside = -1;
    await withTx(
      db,
      scope,
      actor,
      () => {
        seenInside = executed.length;
        return Promise.resolve();
      },
      { audit: 'lazy' },
    );
    expect(seenInside).toBe(1);
    expect(executed.some((e) => e.text.includes('pg_advisory'))).toBe(false);
  });

  it('keys the lock on the tenant of the scope, bound as a parameter', async () => {
    const { db, executed } = fakeDb();
    const other = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    await withTx(db, { ...scope, tenantId: TENANT }, actor, () => Promise.resolve());
    await withTx(db, { ...scope, tenantId: other }, actor, () => Promise.resolve());
    const locks = executed.filter((e) => e.text === LOCK);
    expect(locks.map((e) => e.params)).toEqual([[TENANT], [other]]);
    expect(locks[0]?.text).not.toContain(TENANT);
  });
});

describe('withTx timeouts', () => {
  afterEach(() => {
    configureTx({});
  });

  it('sets lock_timeout, statement_timeout and idle_in_transaction_session_timeout for this transaction only', async () => {
    const { db, setting } = fakeDb();
    const seen: (string | null)[] = [];
    await withTx(db, scope, actor, () => {
      seen.push(
        setting('lock_timeout'),
        setting('statement_timeout'),
        setting('idle_in_transaction_session_timeout'),
      );
      return Promise.resolve();
    });
    expect(seen).toEqual(['5000ms', '15000ms', '30000ms']);
    expect(setting('lock_timeout')).toBeNull();
    expect(setting('statement_timeout')).toBeNull();
  });

  it('lets one transaction override the statement limit, and refuses 0 and fractions (no "off")', async () => {
    const { db, setting } = fakeDb();
    const seen: (string | null)[] = [];
    const read = () => {
      seen.push(setting('statement_timeout'));
      return Promise.resolve();
    };
    await withTx(db, scope, actor, read, { statementTimeoutMs: 30_000 });
    await withTx(db, scope, actor, read);
    expect(seen).toEqual(['30000ms', '15000ms']);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(withTx(db, scope, actor, read, { statementTimeoutMs: bad })).rejects.toThrow(
        'statementTimeoutMs must be a positive integer',
      );
    }
    expect(seen).toHaveLength(2);
  });

  it('uses what configureTx set, and the defaults again for values left out', async () => {
    const { db, setting } = fakeDb();
    const seen: (string | null)[] = [];
    const read = () => {
      seen.push(
        setting('lock_timeout'),
        setting('statement_timeout'),
        setting('idle_in_transaction_session_timeout'),
      );
      return Promise.resolve();
    };
    configureTx({ lockTimeoutMs: 1234, statementTimeoutMs: 2000, idleInTxTimeoutMs: 60_000 });
    await withTx(db, scope, actor, read);
    configureTx({ lockTimeoutMs: 250 });
    await withTx(db, scope, actor, read);
    expect(seen).toEqual(['1234ms', '2000ms', '60000ms', '250ms', '15000ms', '30000ms']);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s, so nothing but an integer reaches the setting',
    (value) => {
      expect(() => configureTx({ lockTimeoutMs: value })).toThrow(
        'lockTimeoutMs must be a non-negative integer',
      );
      expect(() => configureTx({ statementTimeoutMs: value })).toThrow(
        'statementTimeoutMs must be a non-negative integer',
      );
      expect(() => configureTx({ idleInTxTimeoutMs: value })).toThrow(
        'idleInTxTimeoutMs must be a non-negative integer',
      );
    },
  );
});

describe('withTx observer', () => {
  const observer = {
    observeTx: vi.fn(),
    countDbBusy: vi.fn(),
    observeTenantLockWait: vi.fn(),
  } satisfies TxObserver;

  beforeEach(() => {
    observer.observeTx.mockReset();
    observer.countDbBusy.mockReset();
    observer.observeTenantLockWait.mockReset();
    setTxObserver(observer);
  });
  afterEach(() => {
    setTxObserver(undefined);
  });

  it('reports a commit with its setup and total time', async () => {
    const { db } = fakeDb();
    await withTx(db, scope, actor, () => Promise.resolve());
    expect(observer.observeTx).toHaveBeenCalledTimes(1);
    const [outcome, setup, total] = observer.observeTx.mock.calls[0] as [string, number, number];
    expect(outcome).toBe('commit');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThanOrEqual(setup);
    expect(observer.countDbBusy).not.toHaveBeenCalled();
  });

  it.each([
    ['40P01', 'deadlock'],
    ['55P03', 'lock_timeout'],
    ['57014', 'statement_timeout'],
  ])('counts a %s rollback as %s, also through the drizzle wrapper', async (code, kind) => {
    const { db } = fakeDb();
    const pg = Object.assign(new Error('busy'), { code });
    const wrapped = new DrizzleQueryError('update app.x set y = 1', [], pg);
    await expect(withTx(db, scope, actor, () => Promise.reject(wrapped))).rejects.toBe(wrapped);
    expect(observer.observeTx).toHaveBeenCalledWith(
      'rollback',
      expect.any(Number),
      expect.any(Number),
    );
    expect(observer.countDbBusy).toHaveBeenCalledExactlyOnceWith(kind);
  });

  it('reports the wait for the tenant lock, and none for a transaction that never takes it', async () => {
    const { db } = fakeDb();
    await withTx(db, scope, actor, () => Promise.resolve());
    expect(observer.observeTenantLockWait).toHaveBeenCalledTimes(1);
    expect(observer.observeTenantLockWait.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
    observer.observeTenantLockWait.mockReset();
    await withTx(db, scope, actor, () => Promise.resolve(), { audit: 'lazy' });
    expect(observer.observeTenantLockWait).not.toHaveBeenCalled();
  });

  it('reports other rollbacks without counting them as busy', async () => {
    const { db } = fakeDb();
    const boom = Object.assign(new Error('dup'), { code: '23505' });
    await expect(withTx(db, scope, actor, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(observer.observeTx).toHaveBeenCalledTimes(1);
    expect(observer.countDbBusy).not.toHaveBeenCalled();
  });
});

describe('requestTx', () => {
  beforeEach(() => {
    vi.mocked(ctx).mockReset();
    vi.mocked(principal).mockReset();
  });

  it('maps scope from ctx() and the actor id from principal(), not from the ZITADEL sub', () => {
    vi.mocked(ctx).mockReturnValue({
      correlationId: 'req-corr-0001',
      tenantId: 'tenant-9',
      organizationId: 'org-9',
      orgKind: 'company',
      userId: 'zitadel-sub-123',
      roles: [],
      tokenExp: 0,
      ip: '198.51.100.4',
      userAgent: 'curl/8',
    } as unknown as ReturnType<typeof ctx>);
    vi.mocked(principal).mockReturnValue({
      userId: 'b3b7d9f2-3c1e-4a58-9e0a-6f1d2c3b4a5e',
    } as unknown as ReturnType<typeof principal>);

    expect(requestTx()).toEqual({
      scope: { tenantId: 'tenant-9', organizationId: 'org-9' },
      actor: {
        kind: 'user',
        id: 'b3b7d9f2-3c1e-4a58-9e0a-6f1d2c3b4a5e',
        ip: '198.51.100.4',
        userAgent: 'curl/8',
        correlationId: 'req-corr-0001',
      },
    });
  });

  it('passes a null ip and userAgent through, for withTx to store as empty strings', () => {
    vi.mocked(ctx).mockReturnValue({
      correlationId: 'req-corr-0002',
      tenantId: 't',
      organizationId: 'o',
      ip: null,
      userAgent: null,
    } as unknown as ReturnType<typeof ctx>);
    vi.mocked(principal).mockReturnValue({ userId: 'u-1' } as unknown as ReturnType<
      typeof principal
    >);

    const { actor: a } = requestTx();
    expect(a.ip).toBeNull();
    expect(a.userAgent).toBeNull();
  });
});

describe('systemActor', () => {
  it('names the actor system:<job> and mints a valid sys- correlation id', () => {
    const a = systemActor('users.sync');
    expect(a.kind).toBe('system');
    expect(a.id).toBe('system:users.sync');
    expect(a.correlationId).toMatch(/^sys-/);
    expect(a.correlationId).toMatch(CORRELATION_ID);
  });

  it('mints a different correlation id on each call', () => {
    expect(systemActor('j').correlationId).not.toBe(systemActor('j').correlationId);
  });

  it('keeps a correlation id the caller passes', () => {
    expect(systemActor('j', 'job-run-0042').correlationId).toBe('job-run-0042');
  });

  it('refuses an empty job name', () => {
    expect(() => systemActor('')).toThrow('job must be a non-empty string');
  });

  it('produces an actor withTx accepts', async () => {
    const { db, setting } = fakeDb();
    let id: string | null = null;
    await withTx(db, scope, systemActor('nightly'), () => {
      id = setting('bos.actor_id');
      return Promise.resolve();
    });
    expect(id).toBe('system:nightly');
  });
});
