// Unit tests for AuditService against a fake Db (no database, no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.service.fake.test.ts
//
// audit.service.test.ts covers the SQL for real. This file pins what a real database cannot be made to
// produce on demand: a broken chain with a `reason` from audit.verify_chain.
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { AuditService } from './audit.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();

/** A Db whose execute() answers with `rows` and remembers the SQL text it was given. */
function fakeDb(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return {
    db: { execute } as unknown as Db,
    sqlOf: () => dialect.sqlToQuery((execute.mock.calls[0] as [SQL])[0]),
  };
}

describe('AuditService.verifyChain reason', () => {
  it.each(['hash_mismatch', 'prev_hash_mismatch', 'seal_count_mismatch', 'seal_hash_mismatch'])(
    'carries %s through from verify_chain',
    async (reason) => {
      const { db } = fakeDb([{ ok: false, rows: '7', first_bad_seq: '3', reason }]);
      await expect(new AuditService(db).verifyChain(TENANT, '2026-11')).resolves.toEqual({
        tenantId: TENANT,
        month: '2026-11',
        ok: false,
        rows: 7,
        firstBadSeq: 3,
        reason,
      });
    },
  );

  it('answers reason null when verify_chain gives none', async () => {
    const { db } = fakeDb([{ ok: true, rows: '2', first_bad_seq: null, reason: null }]);
    const result = await new AuditService(db).verifyChain(TENANT, '2026-11');
    expect(result).toMatchObject({ ok: true, firstBadSeq: null, reason: null });
  });

  it('still works when verify_chain has no reason column yet', async () => {
    const { db } = fakeDb([{ ok: true, rows: '2', first_bad_seq: null }]);
    const result = await new AuditService(db).verifyChain(TENANT, '2026-11');
    expect(result.reason).toBeNull();
  });

  it('reads reason without naming the column, so it also runs before verify_chain has it', async () => {
    const { db, sqlOf } = fakeDb([{ ok: true, rows: '0', first_bad_seq: null, reason: null }]);
    await new AuditService(db).verifyChain(TENANT, '2026-11');
    expect(sqlOf().sql).toContain(`to_jsonb(v)->>'reason'`);
  });
});

describe('AuditService.list canonical text', () => {
  const row = {
    id: '1',
    tenant_id: TENANT,
    organization_id: TENANT,
    chain_month: '2026-11-01',
    seq: '1',
    occurred_at: '2026-11-08T10:00:00.000001Z',
    actor_kind: 'system',
    actor_id: 'system:test',
    action: 'x.y',
    entity_type: 'x',
    entity_id: '1',
    before: null,
    after: { a: 1.5 },
    meta: null,
    before_text: null,
    after_text: '{"a": 1.50}',
    meta_text: null,
    ip: null,
    user_agent: null,
    correlation_id: 'c',
    prev_hash: Buffer.from('00', 'hex'),
    hash: Buffer.from('ab', 'hex'),
  };

  it('selects the jsonb columns as ::text and passes the text through untouched', async () => {
    const { db, sqlOf } = fakeDb([row]);
    const [event] = await new AuditService(db).list(
      { tenantId: TENANT, organizationId: TENANT },
      { limit: 10 },
    );
    const text = sqlOf().sql;
    expect(text).toMatch(/before::text AS before_text/);
    expect(text).toMatch(/after::text AS after_text/);
    expect(text).toMatch(/meta::text AS meta_text/);
    expect(event?.canonical).toEqual({ before: null, after: '{"a": 1.50}', meta: null });
    expect(event?.after).toEqual({ a: 1.5 });
  });
});
