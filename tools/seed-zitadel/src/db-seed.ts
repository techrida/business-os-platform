// Seed kernel authorization, approval workflows for sales and procurement, and reference data.
// Every write declares the seed actor; re-seeding is idempotent.
//
// Raw SQL on purpose: this tool runs as the table owner and must not depend on the API's Drizzle
// schema. Every statement is idempotent, and `seedKernelRows` returns 0 on a second run.
import { DEFAULT_ROLE_PERMISSIONS, WorkflowSpecSchema, type WorkflowSpec } from '@bos/contracts';
import type pg from 'pg';

import { PERSONAS } from './personas.js';
import {
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
  PO_AMENDMENT_WORKFLOW_SPEC,
  PR_COMMITMENT_WORKFLOW_SPEC,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
  VENDOR_BILL_WORKFLOW_SPEC,
} from './workflow-specs.js';

// The P4 specs live in `workflow-specs.ts` (word-for-word copies; a test in apps/api pins them to the API's).
export {
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
  PO_AMENDMENT_WORKFLOW_SPEC,
  PR_COMMITMENT_WORKFLOW_SPEC,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
  VENDOR_BILL_WORKFLOW_SPEC,
};

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

/**
 * The P3 invoice approval route (plan A5), the same for all three document types: Accountant checks,
 * then Finance approves. Per entity, like every workflow (ADR 0027). There are no amount rules: the
 * route is fixed. An entity whose route is empty refuses submit, so nothing is auto-issued.
 */
const invoiceApprovalSpec = (documentType: string, what: string): unknown => ({
  documentType,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: `Base route: accountant checks the ${what}`,
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
});

export const TAX_INVOICE_WORKFLOW_SPEC: unknown = invoiceApprovalSpec('tax_invoice', 'tax invoice');
export const CREDIT_NOTE_WORKFLOW_SPEC: unknown = invoiceApprovalSpec('credit_note', 'credit note');
export const DEBIT_NOTE_WORKFLOW_SPEC: unknown = invoiceApprovalSpec('debit_note', 'debit note');

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
        `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
         VALUES ($1, $2, $3, $4, true)
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

/**
 * Withholding (TDS) codes, tenant-level (P3 A4). Seeded at 0 bp until the accountant signs the rates; a rate change
 * is a new period, never an edit. Same insert-if-absent rule as seedTaxCodes, for the same reason.
 */
const WITHHOLDING_CODES: readonly { code: string; name: string }[] = [
  { code: 'TDS_SERVICE', name: 'TDS on services' },
  { code: 'TDS_GOODS', name: 'TDS on goods' },
];

async function seedWithholdingCodes(client: pg.ClientBase, scope: SeedScope): Promise<number> {
  let changed = 0;
  for (const w of WITHHOLDING_CODES) {
    const result = await client.query(
      `INSERT INTO app.withholding_codes (tenant_id, code, name, applies_to, rate_bp, effective_from)
       SELECT $1::uuid, $2, $3, 'both', 0, $4::date
       WHERE NOT EXISTS (
         SELECT 1 FROM app.withholding_codes WHERE tenant_id = $1::uuid AND code = $2
       )`,
      [scope.tenantId, w.code, w.name, TAX_CODE_EFFECTIVE_FROM],
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

/**
 * A dev persona as the seed knows it after the ZITADEL step: its stable key, the ZITADEL user id (the token
 * `sub`, which is `app.users.zitadel_user_id`), its login name and its display name.
 */
export interface DevPersona {
  personaKey: string;
  zitadelUserId: string;
  email: string;
  displayName: string;
}

/** The dev procurement flows need these people to exist as rows before anyone has logged in. */
const VENDOR_CREATOR_KEY = 'procurement';
const VENDOR_APPROVER_KEY = 'management';
const DEPARTMENT_HEAD_KEY = 'depthead';
const RECEIPT_CONFIRMER_KEY = 'warehouse';
const DEV_DEPARTMENT_NAME = 'Operations';
/** A nine-digit Nepal PAN (vendors_pan_check). Fictional: the dev vendor is not a real company. */
const DEV_VENDOR_PAN = '123456789';
/** The vendor party the tenancy step creates (SEED_PARTIES.vendor in index.ts; a test pins the two together). */
export const DEV_VENDOR_PARTY_CODE = 'VEND-DEV';
const DEV_VENDOR_TERM = 'NET30';

/** The personas the dev people step needs, in a fixed order; a missing one is an error, not a skip. */
function devPeople(personas: readonly DevPersona[]): (DevPersona & { role: string })[] {
  return [VENDOR_CREATOR_KEY, VENDOR_APPROVER_KEY, DEPARTMENT_HEAD_KEY, RECEIPT_CONFIRMER_KEY].map(
    (key) => {
      const persona = personas.find((p) => p.personaKey === key);
      if (!persona) throw new Error(`dev seed needs persona "${key}" but it was not passed`);
      const role = PERSONAS.find((p) => p.key === key)?.role;
      if (!role) throw new Error(`dev seed: persona "${key}" is not in PERSONAS`);
      return { ...persona, role };
    },
  );
}

/**
 * Dev data that the procurement flows need: procurement, management, department-head and warehouse users with a TR
 * membership each, a department headed by the department head (procurement belongs to it), and VEND-DEV as an
 * approved vendor with a TR account. The API's user mirror would create the users later (JIT or webhook); the
 * vendor's maker-checker columns need real user ids now. Same rules as the mirror: a user is inserted when
 * absent, a membership only when the user has none. Idempotent: a second run changes 0 rows.
 */
async function seedDevPeopleAndVendor(
  client: pg.ClientBase,
  scope: SeedScope,
  personas: readonly DevPersona[],
): Promise<number> {
  const people = devPeople(personas);
  let changed = 0;

  const staffOrg = await client.query<{ id: string }>(
    `SELECT id FROM app.idp_orgs WHERE tenant_id = $1 AND kind = 'staff'`,
    [scope.tenantId],
  );
  const idpOrgId = staffOrg.rows[0]?.id;
  if (!idpOrgId) throw new Error('dev seed: the tenant has no staff app.idp_orgs row');

  for (const person of people) {
    const result = await client.query(
      `INSERT INTO app.users (tenant_id, idp_org_id, zitadel_user_id, email, display_name, status, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now())
       ON CONFLICT (zitadel_user_id) DO NOTHING`,
      [scope.tenantId, idpOrgId, person.zitadelUserId, person.email, person.displayName],
    );
    changed += result.rowCount ?? 0;
  }
  const found = await client.query<{ id: string; zitadel_user_id: string }>(
    `SELECT id, zitadel_user_id FROM app.users WHERE tenant_id = $1 AND zitadel_user_id = ANY($2::text[])`,
    [scope.tenantId, people.map((p) => p.zitadelUserId)],
  );
  const userIdOf = (key: string): string => {
    const zitadelUserId = people.find((p) => p.personaKey === key)?.zitadelUserId;
    const id = found.rows.find((r) => r.zitadel_user_id === zitadelUserId)?.id;
    if (!id) throw new Error(`dev seed: no app.users row for persona "${key}" after the insert`);
    return id;
  };

  for (const person of people) {
    const result = await client.query(
      `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, role_keys)
       SELECT $1::uuid, $2::uuid, $3::uuid, true, $4::text[]
       WHERE NOT EXISTS (
         SELECT 1 FROM app.user_entities WHERE tenant_id = $1::uuid AND user_id = $3::uuid
       )
       ON CONFLICT (tenant_id, organization_id, user_id) DO NOTHING`,
      [scope.tenantId, scope.organizationId, userIdOf(person.personaKey), [person.role]],
    );
    changed += result.rowCount ?? 0;
  }

  // The department: created once by name, then its head is kept equal to the department-head persona.
  const headId = userIdOf(DEPARTMENT_HEAD_KEY);
  const department = await client.query(
    `INSERT INTO app.departments (tenant_id, organization_id, name, head_user_id)
     SELECT $1::uuid, $2::uuid, $3, $4::uuid
     WHERE NOT EXISTS (
       SELECT 1 FROM app.departments WHERE tenant_id = $1::uuid AND organization_id = $2::uuid AND name = $3
     )`,
    [scope.tenantId, scope.organizationId, DEV_DEPARTMENT_NAME, headId],
  );
  changed += department.rowCount ?? 0;
  const head = await client.query(
    `UPDATE app.departments SET head_user_id = $4::uuid, updated_at = now()
     WHERE tenant_id = $1::uuid AND organization_id = $2::uuid AND name = $3
       AND head_user_id IS DISTINCT FROM $4::uuid`,
    [scope.tenantId, scope.organizationId, DEV_DEPARTMENT_NAME, headId],
  );
  changed += head.rowCount ?? 0;
  const departmentRow = await client.query<{ id: string }>(
    `SELECT id FROM app.departments
     WHERE tenant_id = $1 AND organization_id = $2 AND name = $3
     ORDER BY created_at, id LIMIT 1`,
    [scope.tenantId, scope.organizationId, DEV_DEPARTMENT_NAME],
  );
  const departmentId = departmentRow.rows[0]?.id;
  if (!departmentId) throw new Error(`dev seed: department "${DEV_DEPARTMENT_NAME}" not found`);
  const filed = await client.query(
    `UPDATE app.user_entities SET department_id = $4::uuid
     WHERE tenant_id = $1::uuid AND organization_id = $2::uuid AND user_id = $3::uuid
       AND department_id IS DISTINCT FROM $4::uuid`,
    [scope.tenantId, scope.organizationId, userIdOf(VENDOR_CREATOR_KEY), departmentId],
  );
  changed += filed.rowCount ?? 0;

  // VEND-DEV: the party exists already (the tenancy step upserts it). The vendor row takes its id and legal name.
  const party = await client.query<{ id: string }>(
    `SELECT id FROM app.parties WHERE tenant_id = $1 AND code = $2 AND kind = 'vendor'`,
    [scope.tenantId, DEV_VENDOR_PARTY_CODE],
  );
  const partyId = party.rows[0]?.id;
  if (!partyId) throw new Error(`dev seed: vendor party ${DEV_VENDOR_PARTY_CODE} not found`);
  const vendor = await client.query(
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, vat_registered, country, status, created_by, approved_by)
     SELECT p.id, p.tenant_id, p.name, 'company', $3, false, 'NP', 'approved', $4::uuid, $5::uuid
     FROM app.parties p
     WHERE p.tenant_id = $1::uuid AND p.id = $2::uuid
     ON CONFLICT (id) DO NOTHING`,
    [
      scope.tenantId,
      partyId,
      DEV_VENDOR_PAN,
      userIdOf(VENDOR_CREATOR_KEY),
      userIdOf(VENDOR_APPROVER_KEY),
    ],
  );
  changed += vendor.rowCount ?? 0;
  const account = await client.query(
    `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency, payment_term_id)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'NPR', pt.id
     FROM app.payment_terms pt
     WHERE pt.tenant_id = $1::uuid AND pt.code = $4
     ON CONFLICT (tenant_id, organization_id, vendor_id) DO NOTHING`,
    [scope.tenantId, scope.organizationId, partyId, DEV_VENDOR_TERM],
  );
  changed += account.rowCount ?? 0;
  return changed;
}

// `app.number_series` is not seeded: this package does not depend on @bos/locale (so no
// fiscalYearOf), and the API's NumberingService creates each row lazily on first use (MEMO, the
// P2 series QT, LD, DEAL and CUS, and the P4 series PR, RFQ, PO, GRN, BILL and PAY).

/**
 * Seeds the kernel rows in ONE transaction and returns how many rows were inserted or changed.
 * A second run changes nothing and returns 0. With `personas` (the dev personas, from index.ts) it also seeds
 * the dev department and VEND-DEV, which need real user ids; without them that part is skipped.
 */
export async function seedKernelRows(
  client: pg.ClientBase,
  scope: SeedScope,
  personas?: readonly DevPersona[],
): Promise<number> {
  // Parse first so a bad spec fails before any SQL, and so we store the schema's defaulted form.
  const memoSpec = WorkflowSpecSchema.parse(TEST_MEMO_WORKFLOW_SPEC);
  const quotationSpec = WorkflowSpecSchema.parse(QUOTATION_VERSION_WORKFLOW_SPEC);
  const taxInvoiceSpec = WorkflowSpecSchema.parse(TAX_INVOICE_WORKFLOW_SPEC);
  const creditNoteSpec = WorkflowSpecSchema.parse(CREDIT_NOTE_WORKFLOW_SPEC);
  const debitNoteSpec = WorkflowSpecSchema.parse(DEBIT_NOTE_WORKFLOW_SPEC);
  const purchaseRequestSpec = WorkflowSpecSchema.parse(PURCHASE_REQUEST_WORKFLOW_SPEC);
  const prCommitmentSpec = WorkflowSpecSchema.parse(PR_COMMITMENT_WORKFLOW_SPEC);
  const poAmendmentSpec = WorkflowSpecSchema.parse(PO_AMENDMENT_WORKFLOW_SPEC);
  const vendorBillSpec = WorkflowSpecSchema.parse(VENDOR_BILL_WORKFLOW_SPEC);
  const matchExceptionSpec = WorkflowSpecSchema.parse(MATCH_EXCEPTION_WORKFLOW_SPEC);
  const paymentRequestSpec = WorkflowSpecSchema.parse(PAYMENT_REQUEST_WORKFLOW_SPEC);
  // A missing persona fails here, before BEGIN, like a bad spec.
  if (personas && personas.length > 0) devPeople(personas);
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
    // P4: the PR route ends at the department head (AD10); the commitment route runs on the recommended quote.
    changed += await seedWorkflow(client, scope, {
      key: 'purchase_request',
      name: 'Purchase request approval',
      documentType: 'purchase_request',
      spec: purchaseRequestSpec,
    });
    changed += await seedWorkflow(client, scope, {
      key: 'pr_commitment',
      name: 'Purchase commitment approval',
      documentType: 'pr_commitment',
      spec: prCommitmentSpec,
    });
    // An amendment of an approved PO is re-approved on the amended total, on the commitment's route (AD7).
    changed += await seedWorkflow(client, scope, {
      key: 'po_amendment',
      name: 'Purchase order amendment',
      documentType: 'po_amendment',
      spec: poAmendmentSpec,
    });
    // A vendor bill goes Accountant then Finance; a bill outside the match tolerance goes to Finance first (AD5).
    changed += await seedWorkflow(client, scope, {
      key: 'vendor_bill',
      name: 'Vendor bill approval',
      documentType: 'vendor_bill',
      spec: vendorBillSpec,
    });
    changed += await seedWorkflow(client, scope, {
      key: 'match_exception',
      name: 'Match exception approval',
      documentType: 'match_exception',
      spec: matchExceptionSpec,
    });
    // A payment request goes to Finance, plus the AD4 bands unless every bill was matched against its PO (AD5, AD8).
    changed += await seedWorkflow(client, scope, {
      key: 'payment_request',
      name: 'Payment request approval',
      documentType: 'payment_request',
      spec: paymentRequestSpec,
    });
    for (const [code, name] of [
      ['GENERAL', 'General'],
      ['OPERATIONS', 'Operations'],
      ['ADMIN', 'Administration'],
    ]) {
      const result = await client.query(
        `INSERT INTO app.cost_centers (tenant_id, organization_id, code, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, organization_id, code) DO NOTHING`,
        [scope.tenantId, scope.organizationId, code, name],
      );
      changed += result.rowCount ?? 0;
    }
    changed += await seedTaxCodes(client, scope);
    changed += await seedPaymentTerms(client, scope);
    changed += await seedWithholdingCodes(client, scope);
    // P3 sales and invoicing: one Accountant to Finance route per money document (plan A5).
    changed += await seedWorkflow(client, scope, {
      key: 'tax_invoice',
      name: 'Tax invoice approval',
      documentType: 'tax_invoice',
      spec: taxInvoiceSpec,
    });
    changed += await seedWorkflow(client, scope, {
      key: 'credit_note',
      name: 'Credit note approval',
      documentType: 'credit_note',
      spec: creditNoteSpec,
    });
    changed += await seedWorkflow(client, scope, {
      key: 'debit_note',
      name: 'Debit note approval',
      documentType: 'debit_note',
      spec: debitNoteSpec,
    });
    // After the payment terms (the vendor account points at NET30).
    if (personas && personas.length > 0) {
      changed += await seedDevPeopleAndVendor(client, scope, personas);
    }
    await client.query('COMMIT');
    return changed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
