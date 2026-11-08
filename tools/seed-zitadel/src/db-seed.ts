// Seed rows that the API kernel needs on day one: the default role grants, the `test_memo` and
// `quotation_version` approval workflows, the INR peg and the P2 quotation reference data (tax codes
// and payment terms). Serves the NFR "authorization is deny-by-default" (an empty
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

/**
 * v1 of the quotation approval route (P2). Per entity, like every workflow (ADR 0027). The facts come
 * from the quotation preview and submit: `amountNpr` (grand total in NPR, a decimal string),
 * `discountApprovalRequired` (the exact strictly-above-12% flag) and `effectiveDiscountPct` (only
 * shown in the reason). The conditions engine compares booleans with `===`, so `eq true` is safe.
 */
export const QUOTATION_VERSION_WORKFLOW_SPEC: unknown = {
  documentType: 'quotation_version',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the quotation',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'management',
      when: {
        any: [
          { field: 'amountNpr', op: 'gt', value: '100000' },
          { field: 'discountApprovalRequired', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason:
          'Management approval: above 1,00,000 NPR or a discount above 12% ({effectiveDiscountPct}%)',
      },
      position: 'end',
      reason: 'Amount over NPR 1,00,000 or discount above 12%',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because the NPR amount exceeds 10,00,000',
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
  const keptRoles: string[] = [];
  const keptPermissions: string[] = [];
  for (const [roleKey, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const [permission, permissionScope] of Object.entries(grants)) {
      keptRoles.push(roleKey);
      keptPermissions.push(permission);
      // WHERE ... IS DISTINCT FROM makes an unchanged row a no-op, so rowCount is 0 on a re-run.
      const result = await client.query(
        `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, role_key, permission) DO UPDATE
           SET scope = EXCLUDED.scope
           WHERE role_permissions.scope IS DISTINCT FROM EXCLUDED.scope
         RETURNING id`,
        [scope.tenantId, roleKey, permission, permissionScope],
      );
      changed += result.rowCount ?? 0;
    }
  }
  // Review R25: a grant dropped from the defaults must also leave the table, or it keeps granting
  // forever. P1 has no roles editor, so every row in this tenant came from an earlier seed run. The
  // keep-list goes in as two parallel arrays; once the stale rows are gone a re-run deletes nothing.
  const stale = await client.query(
    `DELETE FROM app.role_permissions
     WHERE tenant_id = $1
       AND (role_key, permission) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))
     RETURNING id`,
    [scope.tenantId, keptRoles, keptPermissions],
  );
  changed += stale.rowCount ?? 0;
  if (changed > 0) {
    // The API caches grants per authz version; without a bump, running instances keep stale roles.
    const bump = await client.query(
      `INSERT INTO app.authz_versions (tenant_id, version)
       VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE
         SET version = authz_versions.version + 1`,
      [scope.tenantId],
    );
    changed += bump.rowCount ?? 0;
  }
  return changed;
}

interface WorkflowSeed {
  key: string;
  name: string;
  documentType: string;
  spec: WorkflowSpec;
}

async function seedWorkflow(
  client: pg.ClientBase,
  scope: SeedScope,
  workflow: WorkflowSeed,
): Promise<number> {
  let changed = 0;
  const definition = await client.query(
    `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, organization_id, key) DO NOTHING`,
    [scope.tenantId, scope.organizationId, workflow.key, workflow.name, workflow.documentType],
  );
  changed += definition.rowCount ?? 0;

  const found = await client.query<{ id: string }>(
    `SELECT id FROM app.workflow_definitions
     WHERE tenant_id = $1 AND organization_id = $2 AND key = $3`,
    [scope.tenantId, scope.organizationId, workflow.key],
  );
  const definitionId = found.rows[0]?.id;
  if (!definitionId) throw new Error(`workflow definition ${workflow.key} not found after insert`);

  // A published spec is immutable (a trigger enforces it), so an existing v1 is never rewritten.
  const version = await client.query<{ id: string }>(
    `INSERT INTO app.workflow_versions
       (tenant_id, organization_id, definition_id, version, status, spec, published_at, published_by)
     VALUES ($1, $2, $3, 1, 'published', $4::jsonb, now(), NULL)
     ON CONFLICT (tenant_id, definition_id, version) DO NOTHING
     RETURNING id`,
    [scope.tenantId, scope.organizationId, definitionId, JSON.stringify(workflow.spec)],
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

interface TaxCodeSeed {
  code: string;
  name: string;
  kind: 'vat' | 'exempt' | 'zero';
  rateBp: number;
  creditable: boolean;
}

/** Tenant-level (one list for every entity). Nepal VAT is 13%; exempt and zero-rated carry rate 0. */
const TAX_CODES: readonly TaxCodeSeed[] = [
  { code: 'VAT13', name: 'VAT 13%', kind: 'vat', rateBp: 1300, creditable: true },
  { code: 'EXEMPT', name: 'VAT exempt', kind: 'exempt', rateBp: 0, creditable: false },
  { code: 'ZERO', name: 'Zero-rated', kind: 'zero', rateBp: 0, creditable: false },
];
/** Early enough that any real document date falls inside the first period. */
const TAX_CODE_EFFECTIVE_FROM = '2020-01-01';

/**
 * Inserts a tax code only when the tenant has no row for that code at all. A rate change is a new
 * period (never an edit), so a re-run must not add a second open-ended period beside a later one, and
 * `tax_codes` has no unique key on the code to hang ON CONFLICT on.
 */
async function seedTaxCodes(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  let changed = 0;
  for (const t of TAX_CODES) {
    const result = await client.query(
      `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
       SELECT $1::uuid, $2, $3, $4, $5, $6, $7::date
       WHERE NOT EXISTS (
         SELECT 1 FROM app.tax_codes WHERE tenant_id = $1::uuid AND code = $2
       )`,
      [scope.tenantId, t.code, t.name, t.kind, t.rateBp, t.creditable, TAX_CODE_EFFECTIVE_FROM],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}

const PAYMENT_TERMS: readonly { code: string; name: string; netDays: number }[] = [
  { code: 'NET30', name: 'Net 30 days', netDays: 30 },
  { code: 'ADVANCE', name: 'Advance payment', netDays: 0 },
];

async function seedPaymentTerms(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  let changed = 0;
  for (const term of PAYMENT_TERMS) {
    const result = await client.query(
      `INSERT INTO app.payment_terms (tenant_id, code, name, net_days, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [scope.tenantId, term.code, term.name, term.netDays],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}

async function seedInrPeg(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  const result = await client.query(
    `INSERT INTO app.fx_rates (tenant_id, currency, rate_npr, source, rate_date)
     VALUES ($1, 'INR', $2, 'NRB peg', $3)
     ON CONFLICT (tenant_id, currency, rate_date) DO NOTHING`,
    [scope.tenantId, INR_PEG_RATE, INR_PEG_DATE],
  );
  return result.rowCount ?? 0;
}

// `app.number_series` is not seeded: this package does not depend on @bos/locale (so no
// fiscalYearOf), and the API's NumberingService creates each row lazily on first use (MEMO, and the
// P2 series QT, LD, DEAL and CUS).

/**
 * Seeds the kernel rows in ONE transaction and returns how many rows were inserted or changed.
 * A second run changes nothing and returns 0.
 */
export async function seedKernelRows(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  // Parse first so a bad spec fails before any SQL, and so we store the schema's defaulted form.
  const memoSpec = WorkflowSpecSchema.parse(TEST_MEMO_WORKFLOW_SPEC);
  const quotationSpec = WorkflowSpecSchema.parse(QUOTATION_VERSION_WORKFLOW_SPEC);
  await client.query('BEGIN');
  try {
    await setSeedActor(client, scope);
    let changed = await seedRolePermissions(client, scope);
    changed += await seedWorkflow(client, scope, {
      key: 'test_memo',
      name: 'Test memo approval',
      documentType: 'test_memo',
      spec: memoSpec,
    });
    changed += await seedInrPeg(client, scope);
    changed += await seedWorkflow(client, scope, {
      key: 'quotation_version',
      name: 'Quotation version approval',
      documentType: 'quotation_version',
      spec: quotationSpec,
    });
    changed += await seedTaxCodes(client, scope);
    changed += await seedPaymentTerms(client, scope);
    await client.query('COMMIT');
    return changed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
