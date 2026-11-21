// Integration tests for migration 0011_approval_backstops: the database refuses a decision that breaks
// separation of duties, a second decision on one step, and a return or reject without a comment, even when
// a service bug lets the row through. Needs Docker (Testcontainers, postgres:16-alpine).
// Run with: pnpm --filter @bos/db exec vitest run src/approval-backstops.test.ts
//
// The setup mirrors documents-state.test.ts (roles, database, default privileges, migrate as bos_owner). The
// writes run as bos_app inside one transaction with the bos.* settings, like withTx() does, because the audit
// triggers on the approval tables refuse a write without an actor.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let superuser: Pool;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Runs fn in one transaction on bos_app, after set_config(..., true) of the bos.* settings (like withTx). */
async function inTx<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const settings: Record<string, string> = {
    'bos.tenant_id': scope.tenantId,
    'bos.organization_id': scope.organizationId,
    'bos.actor_kind': 'system',
    'bos.actor_id': 'approval-backstops-test',
    'bos.correlation_id': randomUUID(),
    'bos.ip': '',
    'bos.user_agent': '',
  };
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      await c.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** A fresh tenant with its default legal entity (the entity owns the rows these tests write). */
async function newScope(): Promise<Scope> {
  const { tenantId, organizationId } = await createTenantWithEntity(app);
  return { tenantId, organizationId };
}

interface Fixture {
  scope: Scope;
  requestId: string;
  stepIds: string[];
  /** The preparer: listed in the request's sod_user_ids. */
  preparer: string;
  approver: string;
}

/** A pending request with two steps (seq 1 active, seq 2 waiting) whose sod_user_ids holds the preparer. */
async function newRequest(inScope?: Scope): Promise<Fixture> {
  const scope = inScope ?? (await newScope());
  const preparer = randomUUID();
  const approver = randomUUID();
  return inTx(scope, async (c) => {
    const { tenantId, organizationId } = scope;
    const def = await c.query<{ id: string }>(
      `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
       VALUES ($1, $2, 'memo', 'Memo', 'test_memo') RETURNING id`,
      [tenantId, organizationId],
    );
    const definitionId = def.rows[0]?.id;
    const ver = await c.query<{ id: string }>(
      `INSERT INTO app.workflow_versions (tenant_id, organization_id, definition_id, version, spec)
       VALUES ($1, $2, $3, 1, '{}') RETURNING id`,
      [tenantId, organizationId, definitionId],
    );
    const req = await c.query<{ id: string }>(
      `INSERT INTO app.approval_requests (tenant_id, organization_id, definition_id, workflow_version_id,
         document_type, document_id, document_number, title, snapshot, snapshot_sha256, facts,
         requester_user_id, sod_user_ids, status, current_seq)
       VALUES ($1, $2, $3, $4, 'test_memo', $5, 'MEMO-1', 'A memo', '{}', $6, '{}', $7, $8, 'pending', 1)
       RETURNING id`,
      [
        tenantId,
        organizationId,
        definitionId,
        ver.rows[0]?.id,
        randomUUID(),
        Buffer.alloc(32, 1),
        preparer,
        [preparer],
      ],
    );
    const requestId = req.rows[0]?.id ?? '';
    const steps = await c.query<{ id: string }>(
      `INSERT INTO app.approval_steps (tenant_id, organization_id, request_id, seq, kind, user_id, reason, status)
       VALUES ($1, $2, $3, 1, 'user', $4, 'test', 'active'), ($1, $2, $3, 2, 'user', $4, 'test', 'waiting')
       RETURNING id`,
      [tenantId, organizationId, requestId, approver],
    );
    return { scope, requestId, stepIds: steps.rows.map((r) => r.id), preparer, approver };
  });
}

interface ActionRow {
  action: string;
  actor: string;
  onBehalfOf?: string | null;
  comment?: string | null;
  stepId?: string | null;
}

/** Inserts one approval_actions row as bos_app, shaped like RequestsService.writeAction for a decision. */
function insertAction(f: Fixture, a: ActionRow & { key?: string }) {
  return inTx(f.scope, (c) =>
    c.query(
      `INSERT INTO app.approval_actions (tenant_id, organization_id, request_id, step_id, actor_user_id,
         on_behalf_of_user_id, action, comment, idempotency_key, request_hash, request_version, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 2, '{}')`,
      [
        f.scope.tenantId,
        f.scope.organizationId,
        f.requestId,
        a.stepId === undefined ? f.stepIds[0] : a.stepId,
        a.actor,
        a.onBehalfOf ?? null,
        a.action,
        a.comment ?? null,
        a.key ?? randomUUID(),
        Buffer.alloc(32, 2),
      ],
    ),
  );
}

async function actionCount(requestId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.approval_actions WHERE request_id = $1',
    [requestId],
  );
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  superuser = new Pool({ connectionString: testDb.adminUrl, max: 1 });

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 5 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await superuser?.end();
  await testDb?.drop();
});

/** A second legal entity of the fixture's tenant (not the default one). */
async function addEntity(tenantId: string): Promise<Scope> {
  const organizationId = randomUUID();
  await inTx({ tenantId, organizationId }, (c) =>
    c.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
       VALUES ($1, $2, $1, $3, 'Second entity', 'Second entity Ltd', false)`,
      [organizationId, tenantId, `S${organizationId.slice(0, 6)}`],
    ),
  );
  return { tenantId, organizationId };
}

describe('an approval action idempotency key is scoped to the entity (R5 FU6, 0166)', () => {
  it('lets one approver reuse a key in another entity of the tenant, and refuses it twice in one entity', async () => {
    const first = await newRequest();
    const second = await newRequest(await addEntity(first.scope.tenantId));
    const approver = randomUUID();
    const key = `key-${randomUUID()}`;
    await insertAction(first, { action: 'approve', actor: approver, key });
    // The same tenant, approver and key in the other entity: its own namespace, so it is accepted.
    await insertAction(second, { action: 'approve', actor: approver, key });
    // Within one entity the key is still unique for the approver.
    await expect(
      insertAction(first, { action: 'approve', actor: approver, key, stepId: first.stepIds[1] }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'approval_actions_idempotency_unique' });
  });
});

describe('separation of duties on decisions', () => {
  it('refuses an approve by a user in sod_user_ids with 23514', async () => {
    const f = await newRequest();
    await expect(insertAction(f, { action: 'approve', actor: f.preparer })).rejects.toMatchObject({
      code: '23514',
      constraint: 'approval_actions_sod_check',
    });
    expect(await actionCount(f.requestId)).toBe(0);
  });

  it('refuses a decision on behalf of a user in sod_user_ids with 23514', async () => {
    const f = await newRequest();
    await expect(
      insertAction(f, {
        action: 'reject',
        actor: f.approver,
        onBehalfOf: f.preparer,
        comment: 'no budget',
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'approval_actions_sod_check' });
  });

  it('lets a user in sod_user_ids write the non-decision actions (submit, block)', async () => {
    const f = await newRequest();
    await insertAction(f, { action: 'submit', actor: f.preparer, stepId: null });
    await insertAction(f, {
      action: 'block',
      actor: f.preparer,
      stepId: null,
      comment: 'no route',
    });
    expect(await actionCount(f.requestId)).toBe(2);
  });

  it('accepts an approve by an eligible approver', async () => {
    const f = await newRequest();
    await insertAction(f, { action: 'approve', actor: f.approver });
    expect(await actionCount(f.requestId)).toBe(1);
  });
});

describe('one decision per step', () => {
  it('refuses a second decision on the same step with 23505', async () => {
    const f = await newRequest();
    await insertAction(f, { action: 'approve', actor: f.approver });
    await expect(
      insertAction(f, { action: 'reject', actor: randomUUID(), comment: 'late' }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'approval_actions_one_decision_per_step',
    });
    expect(await actionCount(f.requestId)).toBe(1);
  });

  it('accepts a decision on the next step of the same request', async () => {
    const f = await newRequest();
    await insertAction(f, { action: 'approve', actor: f.approver });
    await insertAction(f, { action: 'approve', actor: randomUUID(), stepId: f.stepIds[1] ?? null });
    expect(await actionCount(f.requestId)).toBe(2);
  });
});

describe('comment on return and reject', () => {
  it('refuses a reject with a blank comment with 23514', async () => {
    const f = await newRequest();
    await expect(
      insertAction(f, { action: 'reject', actor: f.approver, comment: ' \t\n ' }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'approval_actions_comment_check' });
  });

  it('refuses a return without a comment with 23514', async () => {
    const f = await newRequest();
    await expect(insertAction(f, { action: 'return', actor: f.approver })).rejects.toMatchObject({
      code: '23514',
      constraint: 'approval_actions_comment_check',
    });
  });

  it('accepts a return with a comment', async () => {
    const f = await newRequest();
    await insertAction(f, { action: 'return', actor: f.approver, comment: 'fix the total' });
    expect(await actionCount(f.requestId)).toBe(1);
  });
});
