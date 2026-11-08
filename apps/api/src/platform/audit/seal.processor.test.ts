// Unit tests for the monthly audit seal job and its schedule (no database, no Valkey).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/seal.processor.test.ts
// The SQL side (audit.seal, audit.tenants_with_rows) is tested on a real Postgres in
// packages/db/src/audit.test.ts.
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { type Job, type Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { AUDIT_SEAL_JOB, SealProcessor, SealScheduler, previousUtcMonth } from './seal.processor';

const job = (name: string): Job => ({ name }) as Job;

interface Statement {
  text: string;
  params: unknown[];
  inTx: boolean;
}

/**
 * A db that renders each statement with drizzle's real Postgres dialect and answers by its text:
 * the tenant list, a tenant's entity, and audit.seal (which fails for `brokenTenant`). A tenant's entity
 * query answers `orgs` when it asks for the default entity (`is_default`) and `oldestOrgs` when it does
 * not, so a test can tell the two apart (ADR 0027: the seal scope is the default entity).
 */
function fakeDb(opts: {
  tenants: string[];
  orgs: Record<string, string>;
  oldestOrgs?: Record<string, string>;
  alreadySealed?: string[];
  brokenTenant?: string;
}) {
  const dialect = new PgDialect();
  const executed: Statement[] = [];
  let inTx = false;

  const execute = (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    executed.push({ text, params, inTx });
    if (text.includes('audit.tenants_with_rows')) {
      return Promise.resolve({ rows: opts.tenants.map((tenant_id) => ({ tenant_id })) });
    }
    if (text.includes('app.organizations')) {
      const source = text.includes('is_default') ? opts.orgs : (opts.oldestOrgs ?? opts.orgs);
      const org = source[String(params[0])];
      return Promise.resolve({ rows: org === undefined ? [] : [{ id: org }] });
    }
    if (text.includes('audit.seal')) {
      const tenant = String(params[0]);
      if (tenant === opts.brokenTenant) {
        return Promise.reject(new Error('audit.seal: chain is broken at seq 2; refusing to seal'));
      }
      return Promise.resolve({
        rows: [{ sealed: !(opts.alreadySealed ?? []).includes(tenant), last_seq: '7' }],
      });
    }
    return Promise.resolve({ rows: [] });
  };

  const db = {
    execute,
    transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn({ execute });
      } finally {
        inTx = false;
      }
    },
  };
  return { db: db as unknown as Db, executed };
}

const sealCalls = (executed: Statement[]) => executed.filter((s) => s.text.includes('audit.seal'));

describe('previousUtcMonth', () => {
  it('counts UTC months, including across a year', () => {
    expect(previousUtcMonth(new Date('2026-11-08T10:00:00Z'))).toBe('2026-10-01');
    expect(previousUtcMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-01');
    // 02:00 Kathmandu on 1 Nov is still 31 Oct in UTC, so the previous UTC month is September.
    expect(previousUtcMonth(new Date('2026-10-31T20:15:00Z'))).toBe('2026-09-01');
  });
});

describe('SealProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the tenants of the previous UTC month and seals each inside withTx', async () => {
    const { db, executed } = fakeDb({
      tenants: ['t-1', 't-2'],
      orgs: { 't-1': 'o-1', 't-2': 'o-2' },
      alreadySealed: ['t-2'],
    });

    const result = await new SealProcessor(db).process(job(AUDIT_SEAL_JOB));

    expect(result).toEqual({ month: '2026-10-01', tenants: 2, sealed: 1, alreadySealed: 1 });
    expect(executed[0]?.text).toContain('audit.tenants_with_rows');
    expect(executed[0]?.params).toEqual(['2026-10-01']);
    expect(sealCalls(executed).map((s) => [s.params, s.inTx])).toEqual([
      [['t-1', '2026-10-01'], true],
      [['t-2', '2026-10-01'], true],
    ]);

    // withTx's first statement in each transaction sets the scope (default entity) and the system actor.
    const setConfigs = executed.filter((s) => s.text.includes('set_config'));
    expect(setConfigs).toHaveLength(2);
    expect(setConfigs[0]?.params.slice(0, 4)).toEqual([
      't-1',
      'o-1',
      'system',
      'system:audit-seal',
    ]);
    expect(setConfigs[1]?.params.slice(0, 4)).toEqual([
      't-2',
      'o-2',
      'system',
      'system:audit-seal',
    ]);
    // One correlation id for the whole run.
    expect(setConfigs[0]?.params[4]).toBe(setConfigs[1]?.params[4]);
  });

  it('seals under the default entity, not the oldest organization', async () => {
    const { db, executed } = fakeDb({
      tenants: ['t-1'],
      orgs: { 't-1': 'o-default' },
      oldestOrgs: { 't-1': 'o-oldest-but-not-default' },
    });

    await new SealProcessor(db).process(job(AUDIT_SEAL_JOB));

    const setConfigs = executed.filter((s) => s.text.includes('set_config'));
    expect(setConfigs).toHaveLength(1);
    expect(setConfigs[0]?.params.slice(0, 2)).toEqual(['t-1', 'o-default']);
  });

  it('keeps sealing after one tenant fails, then fails the job naming it', async () => {
    const { db, executed } = fakeDb({
      tenants: ['t-1', 't-bad', 't-noorg', 't-3'],
      orgs: { 't-1': 'o-1', 't-bad': 'o-bad', 't-3': 'o-3' },
      brokenTenant: 't-bad',
    });

    const run = new SealProcessor(db).process(job(AUDIT_SEAL_JOB));

    await expect(run).rejects.toThrow(/2 of 4 tenant\(s\) failed/);
    await expect(run).rejects.toThrow(/t-bad: audit\.seal: chain is broken/);
    await expect(run).rejects.toThrow(/t-noorg: tenant has no default entity/);
    expect(sealCalls(executed).map((s) => s.params[0])).toEqual(['t-1', 't-bad', 't-3']);
  });

  it('does nothing for a month without rows', async () => {
    const { db, executed } = fakeDb({ tenants: [], orgs: {} });
    await expect(new SealProcessor(db).process(job(AUDIT_SEAL_JOB))).resolves.toEqual({
      month: '2026-10-01',
      tenants: 0,
      sealed: 0,
      alreadySealed: 0,
    });
    expect(sealCalls(executed)).toEqual([]);
  });

  it('fails a job it does not know, so the bug stays visible', async () => {
    const { db, executed } = fakeDb({ tenants: ['t-1'], orgs: { 't-1': 'o-1' } });
    await expect(new SealProcessor(db).process(job('audit.mystery'))).rejects.toThrow(
      'Unknown audit job: audit.mystery',
    );
    expect(executed).toEqual([]);
  });
});

describe('SealScheduler', () => {
  it('upserts one monthly seal at 02:00 Kathmandu on the 1st', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await new SealScheduler({ upsertJobScheduler } as unknown as Queue).onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'audit.seal.monthly',
      { pattern: '0 6 1 * *', tz: 'Asia/Kathmandu' },
      expect.objectContaining({ name: 'audit.seal' }),
    );
  });
});
