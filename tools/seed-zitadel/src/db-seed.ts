// Seed rows that the API kernel needs on day one: the default role grants, the `test_memo`
// approval workflow and the INR peg. Serves the NFR "authorization is deny-by-default" (an empty
// role_permissions table would deny everyone) and R5 of the P1 plan: the audit trigger RAISEs when
// `bos.actor_id` is unset, so every write here first declares a `seed` actor inside its transaction.
//
// Raw SQL on purpose: this tool runs as the table owner and must not depend on the API's Drizzle
// schema. Every statement is idempotent, and `seedKernelRows` returns 0 on a second run.
import { DEFAULT_ROLE_PERMISSIONS, WorkflowSpecSchema, type WorkflowSpec } from '@bos/contracts';
import type pg from 'pg';

export interface SeedScope {
  tenantId: string;
  organizationId: string;
  correlationId: string;
}

/**
 * Declares who is writing, for the audit trigger. `is_local=true` ties the settings to the open
 * transaction, so they vanish on COMMIT/ROLLBACK and cannot leak to the next statement on a pooled
 * connection. Call it only after BEGIN: outside a transaction `is_local` would last one statement.
 */
export async function setSeedActor(client: pg.ClientBase, scope: SeedScope): Promise<void> {
  await client.query(
    `SELECT set_config('bos.tenant_id', $1, true),
            set_config('bos.organization_id', $2, true),
            set_config('bos.actor_kind', $3, true),
            set_config('bos.actor_id', $4, true),
            set_config('bos.correlation_id', $5, true),
            set_config('bos.ip', $6, true),
            set_config('bos.user_agent', $7, true)`,
    [scope.tenantId, scope.organizationId, 'seed', 'seed', scope.correlationId, '', ''],
  );
}

/** v1 of the demo approval route; the thresholds are NPR (the engine compares decimals, not floats). */
export const TEST_MEMO_WORKFLOW_SPEC: unknown = {
  documentType: 'test_memo',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the memo',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'mgmt-over-1-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '100000' },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because NPR equivalent exceeds 1,00,000',
      },
      position: 'end',
      reason: 'Amount over NPR 1,00,000',
    },
    {
      id: 'founder-over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
      },
      position: 'end',
      reason: 'Amount over NPR 10,00,000',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

/** The INR to NPR peg is fixed by Nepal Rastra Bank, so it is data, not code (plan section 3). */
const INR_PEG_RATE = '1.6';
/** Earliest date, so a "latest rate on or before the document date" lookup always finds the peg. */
const INR_PEG_DATE = '2000-01-01';

async function seedRolePermissions(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  let changed = 0;
  for (const [roleKey, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const [permission, permissionScope] of Object.entries(grants)) {
      // WHERE ... IS DISTINCT FROM makes an unchanged row a no-op, so rowCount is 0 on a re-run.
      const result = await client.query(
        `INSERT INTO app.role_permissions (tenant_id, organization_id, role_key, permission, scope)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, organization_id, role_key, permission) DO UPDATE
           SET scope = EXCLUDED.scope
           WHERE role_permissions.scope IS DISTINCT FROM EXCLUDED.scope
         RETURNING id`,
        [scope.tenantId, scope.organizationId, roleKey, permission, permissionScope],
      );
      changed += result.rowCount ?? 0;
    }
  }
  if (changed > 0) {
    // The API caches grants per authz version; without a bump, running instances keep stale roles.
    const bump = await client.query(
      `INSERT INTO app.authz_versions (tenant_id, organization_id, version)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, organization_id) DO UPDATE
         SET version = authz_versions.version + 1`,
      [scope.tenantId, scope.organizationId],
    );
    changed += bump.rowCount ?? 0;
  }
  return changed;
}

async function seedTestMemoWorkflow(
  client: pg.ClientBase,
  scope: SeedScope,
  spec: WorkflowSpec,
): Promise<number> {
  let changed = 0;
  const definition = await client.query(
    `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
     VALUES ($1, $2, 'test_memo', 'Test memo approval', 'test_memo')
     ON CONFLICT (tenant_id, organization_id, key) DO NOTHING`,
    [scope.tenantId, scope.organizationId],
  );
  changed += definition.rowCount ?? 0;

  const found = await client.query<{ id: string }>(
    `SELECT id FROM app.workflow_definitions
     WHERE tenant_id = $1 AND organization_id = $2 AND key = 'test_memo'`,
    [scope.tenantId, scope.organizationId],
  );
  const definitionId = found.rows[0]?.id;
  if (!definitionId) throw new Error('workflow definition test_memo not found after insert');

  // A published spec is immutable (a trigger enforces it), so an existing v1 is never rewritten.
  const version = await client.query<{ id: string }>(
    `INSERT INTO app.workflow_versions
       (tenant_id, organization_id, definition_id, version, status, spec, published_at, published_by)
     VALUES ($1, $2, $3, 1, 'published', $4::jsonb, now(), NULL)
     ON CONFLICT (definition_id, version) DO NOTHING
     RETURNING id`,
    [scope.tenantId, scope.organizationId, definitionId, JSON.stringify(spec)],
  );
  const versionId = version.rows[0]?.id;
  if (versionId) {
    changed += version.rowCount ?? 1;
    const current = await client.query(
      `UPDATE app.workflow_definitions SET current_version_id = $1
       WHERE id = $2 AND current_version_id IS NULL`,
      [versionId, definitionId],
    );
    changed += current.rowCount ?? 0;
  }
  return changed;
}

async function seedInrPeg(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  const result = await client.query(
    `INSERT INTO app.fx_rates (tenant_id, organization_id, currency, rate_npr, source, rate_date)
     VALUES ($1, $2, 'INR', $3, 'NRB peg', $4)
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.organizationId, INR_PEG_RATE, INR_PEG_DATE],
  );
  return result.rowCount ?? 0;
}

// `app.number_series` is not seeded: this package does not depend on @bos/locale (so no
// fiscalYearOf), and the API's NumberingService creates the MEMO row lazily on first use.

/**
 * Seeds the kernel rows in ONE transaction and returns how many rows were inserted or changed.
 * A second run changes nothing and returns 0.
 */
export async function seedKernelRows(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  // Parse first so a bad spec fails before any SQL, and so we store the schema's defaulted form.
  const spec = WorkflowSpecSchema.parse(TEST_MEMO_WORKFLOW_SPEC);
  await client.query('BEGIN');
  try {
    await setSeedActor(client, scope);
    let changed = await seedRolePermissions(client, scope);
    changed += await seedTestMemoWorkflow(client, scope, spec);
    changed += await seedInrPeg(client, scope);
    await client.query('COMMIT');
    return changed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
