// Unit tests for AuditService against a fake Db (no database, no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.service.fake.test.ts
//
// audit.service.test.ts covers the SQL for real. This file pins what a real database cannot be made to
// produce on demand: a broken chain with a `reason` from audit.verify_chain.
import { AuditEventDtoSchema } from '@bos/contracts';
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

describe('AuditService.list actor names', () => {
  const ACCOUNTANT = '22222222-2222-4222-8222-222222222222';
  const FINANCE = '33333333-3333-4333-8333-333333333333';
  const OTHER_TENANT_USER = '44444444-4444-4444-8444-444444444444';
  const scope = { tenantId: TENANT, organizationId: TENANT };

  const base = {
    tenant_id: TENANT,
    organization_id: TENANT,
    chain_month: '2026-11-01',
    occurred_at: '2026-11-08T10:00:00.000001Z',
    action: 'approval.approved',
    entity_type: 'approval_request',
    entity_id: 'r1',
    before: null,
    after: null,
    meta: null,
    before_text: null,
    after_text: null,
    meta_text: null,
    ip: null,
    user_agent: null,
    correlation_id: 'c',
    prev_hash: Buffer.from('00', 'hex'),
    hash: Buffer.from('ab', 'hex'),
  };
  const event = (id: string, kind: string, actorId: string) => ({
    ...base,
    id,
    seq: id,
    actor_kind: kind,
    actor_id: actorId,
  });

  /** Answers the events query first, then the users query, and keeps both statements. */
  function twoStepDb(events: unknown[], users: unknown[]) {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: events })
      .mockResolvedValueOnce({ rows: users });
    const sqls = () => execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL));
    return { db: { execute } as unknown as Db, execute, sqls };
  }

  it('adds the display name of a seeded person, one batched tenant-scoped query for the whole page', async () => {
    const { db, execute, sqls } = twoStepDb(
      [
        event('1', 'user', ACCOUNTANT),
        event('2', 'user', ACCOUNTANT),
        event('3', 'user', FINANCE),
        event('4', 'system', 'system:seal'),
      ],
      [
        { id: ACCOUNTANT, display_name: 'Dev Accountant' },
        { id: FINANCE, display_name: 'Dev Finance' },
      ],
    );
    const events = await new AuditService(db).list(scope, { limit: 10 });

    expect(execute).toHaveBeenCalledTimes(2);
    const users = sqls()[1];
    expect(users?.sql).toMatch(/FROM app\.users/);
    expect(users?.sql).toMatch(/tenant_id = \$1::uuid/);
    expect(users?.sql).not.toMatch(/email/);
    // The tenant comes from the caller's scope; the ids are deduplicated and the system actor is not looked up.
    expect(users?.params).toEqual([TENANT, ACCOUNTANT, FINANCE]);
    expect(events.map((e) => e.actorDisplayName)).toEqual([
      'Dev Accountant',
      'Dev Accountant',
      'Dev Finance',
      null,
    ]);
    // The consumer's schema (listAudit in the workspace) must not strip the name.
    expect(AuditEventDtoSchema.parse(events[0])).toMatchObject({
      actorDisplayName: 'Dev Accountant',
    });
  });

  it('gives null for an unknown id, another tenant, a blank name and non-user actors', async () => {
    const { db } = twoStepDb(
      [
        event('1', 'user', OTHER_TENANT_USER),
        event('2', 'user', ACCOUNTANT),
        event('3', 'user', 'not-a-uuid'),
        event('4', 'seed', 'seed'),
        event('5', 'zitadel', FINANCE),
      ],
      // The tenant filter keeps OTHER_TENANT_USER out of the rows; FINANCE is a zitadel actor, never asked for.
      [{ id: ACCOUNTANT, display_name: '   ' }],
    );
    const events = await new AuditService(db).list(scope, { limit: 10 });
    expect(events.map((e) => e.actorDisplayName)).toEqual([null, null, null, null, null]);
    expect(events.map((e) => e.actorId)).toEqual([
      OTHER_TENANT_USER,
      ACCOUNTANT,
      'not-a-uuid',
      'seed',
      FINANCE,
    ]);
    for (const e of events) expect(AuditEventDtoSchema.parse(e).actorDisplayName).toBeNull();
  });

  it('does not query users when no event was made by a person, and leaves the hashed fields alone', async () => {
    const { db, execute } = twoStepDb([event('1', 'system', 'system:seal')], []);
    const [e] = await new AuditService(db).list(scope, { limit: 10 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(e).toMatchObject({ actorId: 'system:seal', hash: 'ab', prevHash: '00' });
  });
});
