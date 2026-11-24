// Tests for the kernel seed rows. A fake pg client records every statement and answers from a small
// script, so we can check the order (BEGIN, seed actor, rows, COMMIT) and idempotency without Postgres.
import {
  DEFAULT_ROLE_PERMISSIONS,
  PanVatNoSchema,
  VENDOR_CHECKLIST_ITEM_KEYS,
  WorkflowSpecSchema,
  nepalPanProblem,
  phoneProblem,
  REQUIRED_VENDOR_CHECKLIST_KEYS,
  type CountryCode,
} from '@bos/contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  CREDIT_NOTE_WORKFLOW_SPEC,
  DEBIT_NOTE_WORKFLOW_SPEC,
  TAX_INVOICE_WORKFLOW_SPEC,
  QUOTATION_VERSION_WORKFLOW_SPEC,
  TEST_MEMO_WORKFLOW_SPEC,
  DEV_BANK_ACCOUNTS,
  DEV_EXPENSE_ACCOUNTS,
  DEV_CUSTOMER_CONTACT_PHONES,
  DEV_CUSTOMER_NAME_NORM,
  DEV_CUSTOMER_PARTY_CODE,
  DEV_DEPARTMENTS,
  DEV_FOREIGN_CUSTOMER,
  DEV_FOREIGN_VENDOR,
  DEV_VENDOR_PARTY_CODE,
  type DevPersona,
  seedExtraVendor,
  seedKernelRows,
  setSeedActor,
} from './db-seed.js';
import { PgTenancyStore, SEED_PARTIES, tenancySeed } from './index.js';
import { EXTRA_VENDORS } from './personas.js';
import {
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
  PO_AMENDMENT_WORKFLOW_SPEC,
  PO_VENDOR_CHANGE_WORKFLOW_SPEC,
  PR_COMMITMENT_WORKFLOW_SPEC,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
  VENDOR_BILL_WORKFLOW_SPEC,
} from './workflow-specs.js';

const scope = { tenantId: 'tenant-1', organizationId: 'org-1', correlationId: 'corr-1' };

interface Call {
  text: string;
  values: unknown[];
}
type Reply = { rowCount?: number; rows?: unknown[] };
type Script = (call: Call) => Reply | undefined;

function fakeClient(script: Script = () => undefined) {
  const calls: Call[] = [];
  const client = {
    query: (text: string, values: unknown[] = []) => {
      const call = { text: text.replace(/\s+/g, ' ').trim(), values };
      calls.push(call);
      const reply = script(call);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ rowCount: reply?.rowCount ?? 0, rows: reply?.rows ?? [] });
    },
  };
  return { client: client as unknown as pg.ClientBase, calls };
}

/** First run: every insert changes one row and the version insert returns its id. */
const firstRun: Script = ({ text }) => {
  if (text.startsWith('SELECT id FROM app.workflow_definitions'))
    return { rows: [{ id: 'def-1' }] };
  if (text.includes('INTO app.workflow_versions')) return { rowCount: 1, rows: [{ id: 'ver-1' }] };
  if (text.startsWith('INSERT') || text.startsWith('UPDATE')) return { rowCount: 1 };
  return undefined;
};

/** Second run: ON CONFLICT ... DO NOTHING / unchanged WHERE clauses return no rows. */
const nothingChanged: Script = ({ text }) => {
  if (text.startsWith('SELECT id FROM app.workflow_definitions'))
    return { rows: [{ id: 'def-1' }] };
  return undefined;
};

const grantCount = Object.values(DEFAULT_ROLE_PERMISSIONS).reduce(
  (sum, grants) => sum + Object.keys(grants).length,
  0,
);

describe('setSeedActor', () => {
  it('sets the seed actor in one local set_config statement', async () => {
    const { client, calls } = fakeClient();
    await setSeedActor(client, scope);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.text).toMatch(/^SELECT set_config\('bos\.tenant_id', \$1, true\)/);
    for (const name of [
      'tenant_id',
      'organization_id',
      'actor_kind',
      'actor_id',
      'correlation_id',
      'ip',
      'user_agent',
    ]) {
      expect(call?.text).toContain(`set_config('bos.${name}'`);
    }
    expect(call?.text).not.toContain('false)');
    expect(call?.values).toEqual(['tenant-1', 'org-1', 'seed', 'seed', 'corr-1', '', '']);
  });
});

describe('seedKernelRows', () => {
  it('runs BEGIN, the seed actor, the rows, then COMMIT', async () => {
    const { client, calls } = fakeClient(firstRun);
    const changed = await seedKernelRows(client, scope);

    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls[1]?.text).toContain("set_config('bos.actor_id'");
    expect(calls[1]?.values).toContain('seed');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    expect(calls.filter((c) => c.text === 'BEGIN')).toHaveLength(1);
    expect(calls.some((c) => c.text === 'ROLLBACK')).toBe(false);

    const index = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(index('INTO app.role_permissions')).toBeGreaterThan(1);
    expect(index('INTO app.authz_versions')).toBeGreaterThan(index('INTO app.role_permissions'));
    expect(index('INTO app.workflow_definitions')).toBeGreaterThan(
      index('INTO app.authz_versions'),
    );
    expect(index('INTO app.fx_rates')).toBeGreaterThan(index('INTO app.workflow_versions'));
    // grants + authz bump + 14 x (definition + version + current_version_id) + fx peg
    // + 3 tax codes + 2 payment terms + 2 withholding codes + 3 cost centres + 3 bank and 7 expense accounts
    expect(changed).toBe(grantCount + 1 + 14 * 3 + 1 + 3 + 2 + 2 + 3 + 3 + 7);
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const boom = new Error('trigger raised');
    const { client, calls } = fakeClient(({ text }) => {
      if (text.includes('INTO app.fx_rates')) return boom as unknown as Reply;
      return firstRun({ text, values: [] });
    });
    await expect(seedKernelRows(client, scope)).rejects.toThrow('trigger raised');
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
  });

  it('writes one role_permissions row for every default grant', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const rows = calls
      .filter((c) => c.text.includes('INTO app.role_permissions'))
      .map((c) => c.values);
    expect(rows).toHaveLength(grantCount);
    // role_permissions is tenant-scoped (ADR 0027): no organization_id column, so $1 is the tenant.
    for (const values of rows) expect(values).toHaveLength(4);
    for (const values of rows) expect(values[0]).toBe('tenant-1');

    const written = new Set(rows.map((v) => `${String(v[1])}|${String(v[2])}|${String(v[3])}`));
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const [permission, grantScope] of Object.entries(grants)) {
        expect(written.has(`${role}|${permission}|${grantScope}`)).toBe(true);
      }
    }
    const sql = calls.find((c) => c.text.includes('INTO app.role_permissions'))?.text;
    expect(sql).toContain('ON CONFLICT (tenant_id, role_key, permission)');
    expect(sql).not.toContain('organization_id');
    expect(sql).toContain('IS DISTINCT FROM');
  });

  it('writes the P2 roles tenant-wide, with the review and read-all grants of the plan', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const written = new Set(
      calls
        .filter((c) => c.text.includes('INTO app.role_permissions'))
        .map((c) => `${String(c.values[1])}|${String(c.values[2])}|${String(c.values[3])}`),
    );
    expect(written.has('pmo|verification.review|all')).toBe(true);
    expect(written.has('pmo|quotation.read|all')).toBe(true);
    expect(written.has('founder|customer.merge|all')).toBe(true);
    expect(written.has('sales|quotation.send|own')).toBe(true);
    // Every role with default grants gets rows; portal roles have none by design.
    for (const role of ['pmo', 'operations_head']) {
      expect(
        [...written].some((w) => w.startsWith(`${role}|`)),
        role,
      ).toBe(true);
    }
  });

  it('inserts workflow test_memo v1 as published with a valid spec and sets current_version_id', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const definition = calls.find((c) => c.text.includes('INTO app.workflow_definitions'));
    expect(definition?.values).toEqual([
      'tenant-1',
      'org-1',
      'test_memo',
      'Test memo approval',
      'test_memo',
    ]);

    const version = calls.find((c) => c.text.includes('INTO app.workflow_versions'));
    expect(version?.text).toContain("1, 'published', $4::jsonb, now(), NULL");
    expect(version?.text).toContain('ON CONFLICT (tenant_id, definition_id, version) DO NOTHING');
    expect(version?.values.slice(0, 3)).toEqual(['tenant-1', 'org-1', 'def-1']);

    const stored = JSON.parse(String(version?.values[3])) as unknown;
    expect(WorkflowSpecSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({
      documentType: 'test_memo',
      distinctApprovers: true,
      sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
    });
    const spec = WorkflowSpecSchema.parse(stored);
    expect(spec.steps.map((s) => s.role)).toEqual(['accountant', 'finance']);
    expect(spec.rules.map((r) => [r.id, r.add.role])).toEqual([
      ['mgmt-over-1-lakh', 'management'],
      ['founder-over-10-lakh', 'founder'],
    ]);

    const update = calls.find((c) => c.text.startsWith('UPDATE app.workflow_definitions'));
    expect(update?.values).toEqual(['ver-1', 'def-1']);
  });

  it('keeps TEST_MEMO_WORKFLOW_SPEC valid', () => {
    expect(WorkflowSpecSchema.safeParse(TEST_MEMO_WORKFLOW_SPEC).success).toBe(true);
  });

  it('seeds the INR peg at 1.6 from the earliest date', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const fx = calls.find((c) => c.text.includes('INTO app.fx_rates'));
    expect(fx?.text).toContain("'INR'");
    expect(fx?.text).toContain("'NRB peg'");
    expect(fx?.text).toContain('ON CONFLICT (tenant_id, currency, rate_date) DO NOTHING');
    expect(fx?.text).not.toContain('organization_id');
    expect(fx?.values).toEqual(['tenant-1', '1.6', '2000-01-01']);
  });

  it('returns 0 and does not bump authz_versions or touch v1 when nothing changed', async () => {
    const { client, calls } = fakeClient(nothingChanged);
    const changed = await seedKernelRows(client, scope);

    expect(changed).toBe(0);
    expect(calls.some((c) => c.text.includes('INTO app.authz_versions'))).toBe(false);
    expect(calls.some((c) => c.text.startsWith('UPDATE'))).toBe(false);
    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });
});

describe('seedKernelRows: P2 quotation reference data', () => {
  const quotationDefinition = (calls: Call[]) =>
    calls.find(
      (c) =>
        c.text.includes('INTO app.workflow_definitions') && c.values[2] === 'quotation_version',
    );

  it('keeps QUOTATION_VERSION_WORKFLOW_SPEC valid, with the base route and both rules', () => {
    const spec = WorkflowSpecSchema.parse(QUOTATION_VERSION_WORKFLOW_SPEC);
    expect(spec.documentType).toBe('quotation_version');
    expect(spec.distinctApprovers).toBe(true);
    expect(spec.steps.map((s) => [s.id, s.role])).toEqual([
      ['accountant', 'accountant'],
      ['finance', 'finance'],
    ]);
    expect(spec.rules.map((r) => [r.id, r.add.id, r.add.role, r.position])).toEqual([
      ['management', 'management', 'management', 'end'],
      ['over-10-lakh', 'founder', 'founder', 'end'],
    ]);
    expect(spec.rules[0]?.when).toEqual({
      any: [
        { field: 'amountNpr', op: 'gt', value: '100000' },
        { field: 'discountApprovalRequired', op: 'eq', value: true },
      ],
    });
    expect(spec.rules[0]?.add.reason).toBe(
      'Management approval: above 1,00,000 NPR or a discount above 12% ({effectiveDiscountPct}%)',
    );
    expect(spec.rules[1]?.when).toEqual({ field: 'amountNpr', op: 'gt', value: '1000000' });
    expect(spec.rules[1]?.add.reason).toBe(
      'Founder approval because the NPR amount exceeds 10,00,000',
    );
  });

  it('seeds the quotation_version workflow for the entity as published v1', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    expect(quotationDefinition(calls)?.values).toEqual([
      'tenant-1',
      'org-1',
      'quotation_version',
      'Quotation version approval',
      'quotation_version',
    ]);
    const versions = calls.filter((c) => c.text.includes('INTO app.workflow_versions'));
    expect(versions).toHaveLength(14);
    const quotation = versions.find((c) => {
      const spec = JSON.parse(String(c.values[3])) as { documentType: string };
      return spec.documentType === 'quotation_version';
    });
    expect(quotation?.text).toContain("1, 'published', $4::jsonb, now(), NULL");
    expect(quotation?.text).toContain('ON CONFLICT (tenant_id, definition_id, version) DO NOTHING');
  });

  it('seeds VAT13, EXEMPT and ZERO tenant-wide from 2020-01-01, only when the code has no row', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const rows = calls.filter((c) => c.text.includes('INTO app.tax_codes'));
    expect(rows.map((c) => c.values)).toEqual([
      ['tenant-1', 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01'],
      ['tenant-1', 'EXEMPT', 'VAT exempt', 'exempt', 0, false, '2020-01-01'],
      ['tenant-1', 'ZERO', 'Zero-rated', 'zero', 0, false, '2020-01-01'],
    ]);
    for (const row of rows) {
      expect(row.text).not.toContain('organization_id');
      expect(row.text).toContain('WHERE NOT EXISTS');
    }
  });

  it('seeds NET30 and ADVANCE payment terms as active, tenant-wide', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const rows = calls.filter((c) => c.text.includes('INTO app.payment_terms'));
    expect(rows.map((c) => c.values)).toEqual([
      ['tenant-1', 'NET30', 'Net 30 days', 30],
      ['tenant-1', 'ADVANCE', 'Advance payment', 0],
    ]);
    for (const row of rows) {
      expect(row.text).toContain('ON CONFLICT (tenant_id, code) DO NOTHING');
      expect(row.text).toContain('true');
      expect(row.text).not.toContain('organization_id');
    }
  });

  it('does not pre-create number series: NumberingService makes QT, LD, DEAL, CUS and the P4 PR, RFQ, PO, GRN, BILL and PAY on first use', async () => {
    // A counter row is keyed by fiscal year, and this tool has no fiscalYearOf, so a seeded row would be wrong
    // after the next year end. NumberingService.issue inserts the row on first use for every key.
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    expect(calls.some((c) => c.text.includes('number_series'))).toBe(false);
  });

  it('inserts each P2 row once: a second run over the same keys changes nothing', async () => {
    const keys = new Set<string>();
    // A small model of the unique keys: a repeat insert reports rowCount 0, like Postgres.
    const keyOf = ({ text, values }: Call): string | undefined => {
      if (text.includes('INTO app.tax_codes')) return `tax|${String(values[1])}`;
      if (text.includes('INTO app.payment_terms')) return `term|${String(values[1])}`;
      if (text.includes('INTO app.workflow_definitions')) return `def|${String(values[2])}`;
      if (text.includes('INTO app.workflow_versions')) return `ver|${String(values[2])}`;
      return undefined;
    };
    const stateful: Script = (call) => {
      if (call.text.startsWith('SELECT id FROM app.workflow_definitions')) {
        return { rows: [{ id: 'def-1' }] };
      }
      const key = keyOf(call);
      if (key === undefined) return nothingChanged(call);
      if (keys.has(key)) return { rowCount: 0 };
      keys.add(key);
      return call.text.includes('INTO app.workflow_versions')
        ? { rowCount: 1, rows: [{ id: 'ver-1' }] }
        : { rowCount: 1 };
    };
    const first = fakeClient(stateful);
    await seedKernelRows(first.client, scope);
    // 3 tax codes + 2 payment terms + 14 definitions (version rows share def-1 here, so 1 key)
    expect([...keys].filter((k) => k.startsWith('tax|'))).toHaveLength(3);
    expect([...keys].filter((k) => k.startsWith('term|'))).toHaveLength(2);
    expect([...keys].filter((k) => k.startsWith('def|'))).toHaveLength(14);

    const second = fakeClient(stateful);
    expect(await seedKernelRows(second.client, scope)).toBe(0);
    for (const c of second.calls.filter((q) =>
      /INTO app\.(tax_codes|payment_terms)/.test(q.text),
    )) {
      expect(c.text).not.toContain('DO UPDATE');
    }
  });
});

describe('seedKernelRows: P4 purchasing', () => {
  const definitionOf = (calls: Call[], key: string) =>
    calls.find((c) => c.text.includes('INTO app.workflow_definitions') && c.values[2] === key);
  const specOf = (calls: Call[], documentType: string) => {
    const call = calls.find(
      (c) =>
        c.text.includes('INTO app.workflow_versions') &&
        (JSON.parse(String(c.values[3])) as { documentType: string }).documentType === documentType,
    );
    return call ? (JSON.parse(String(call.values[3])) as unknown) : undefined;
  };

  it('seeds purchase_request, pr_commitment, po_amendment and po_vendor_change for the entity, keyed by their document type', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    expect(definitionOf(calls, 'purchase_request')?.values).toEqual([
      'tenant-1',
      'org-1',
      'purchase_request',
      'Purchase request approval',
      'purchase_request',
    ]);
    expect(definitionOf(calls, 'pr_commitment')?.values).toEqual([
      'tenant-1',
      'org-1',
      'pr_commitment',
      'Purchase commitment approval',
      'pr_commitment',
    ]);
    expect(definitionOf(calls, 'po_amendment')?.values).toEqual([
      'tenant-1',
      'org-1',
      'po_amendment',
      'Purchase order amendment',
      'po_amendment',
    ]);
    expect(definitionOf(calls, 'po_vendor_change')?.values).toEqual([
      'tenant-1',
      'org-1',
      'po_vendor_change',
      'Purchase order vendor change',
      'po_vendor_change',
    ]);
    // What is stored is the schema's defaulted form of the API's spec (the parity test pins the copies).
    expect(specOf(calls, 'purchase_request')).toEqual(
      WorkflowSpecSchema.parse(PURCHASE_REQUEST_WORKFLOW_SPEC),
    );
    expect(specOf(calls, 'pr_commitment')).toEqual(
      WorkflowSpecSchema.parse(PR_COMMITMENT_WORKFLOW_SPEC),
    );
    expect(specOf(calls, 'po_amendment')).toEqual(
      WorkflowSpecSchema.parse(PO_AMENDMENT_WORKFLOW_SPEC),
    );
    expect(specOf(calls, 'po_vendor_change')).toEqual(
      WorkflowSpecSchema.parse(PO_VENDOR_CHANGE_WORKFLOW_SPEC),
    );
  });

  it('seeds vendor_bill and match_exception for the entity, keyed by their document type', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    expect(definitionOf(calls, 'vendor_bill')?.values).toEqual([
      'tenant-1',
      'org-1',
      'vendor_bill',
      'Vendor bill approval',
      'vendor_bill',
    ]);
    expect(definitionOf(calls, 'match_exception')?.values).toEqual([
      'tenant-1',
      'org-1',
      'match_exception',
      'Match exception approval',
      'match_exception',
    ]);
    expect(specOf(calls, 'vendor_bill')).toEqual(
      WorkflowSpecSchema.parse(VENDOR_BILL_WORKFLOW_SPEC),
    );
    expect(specOf(calls, 'match_exception')).toEqual(
      WorkflowSpecSchema.parse(MATCH_EXCEPTION_WORKFLOW_SPEC),
    );
  });

  it('seeds payment_request for the entity, keyed by its document type', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    expect(definitionOf(calls, 'payment_request')?.values).toEqual([
      'tenant-1',
      'org-1',
      'payment_request',
      'Payment request approval',
      'payment_request',
    ]);
    expect(specOf(calls, 'payment_request')).toEqual(
      WorkflowSpecSchema.parse(PAYMENT_REQUEST_WORKFLOW_SPEC),
    );
  });

  it('seeds the P2, P4 and P3 workflow definitions in a stable order', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const keys = calls
      .filter((c) => c.text.includes('INTO app.workflow_definitions'))
      .map((c) => c.values[2]);
    expect(keys).toEqual([
      'test_memo',
      'quotation_version',
      'purchase_request',
      'pr_commitment',
      'po_amendment',
      'po_vendor_change',
      'emergency_review',
      'vendor_bill',
      'match_exception',
      'payment_request',
      'tax_invoice',
      'credit_note',
      'debit_note',
      'memo_approver',
    ]);
  });

  it('seeds the Memo approver workflow: the department head, else the Founder (F1-Q9)', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    expect(specOf(calls, 'memo_approver')).toEqual(
      WorkflowSpecSchema.parse({
        documentType: 'memo_approver',
        steps: [
          {
            id: 'approver',
            kind: 'department_head',
            fallbackRole: 'founder',
            reason: "The head of the requester's department approves the memo",
          },
        ],
        rules: [],
      }),
    );
  });

  it('keeps the withholding codes at 0 bp and inserts each only when absent', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const rows = calls.filter((c) => c.text.includes('INTO app.withholding_codes'));
    expect(rows.map((c) => c.values[1])).toEqual(['TDS_SERVICE', 'TDS_GOODS']);
    for (const row of rows) {
      expect(row.text).toContain("'both', 0,");
      expect(row.text).toContain('WHERE NOT EXISTS');
    }
  });

  it('grants receipt confirmation to warehouse and PR creation to operations_officer', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const written = new Set(
      calls
        .filter((c) => c.text.includes('INTO app.role_permissions'))
        .map((c) => `${String(c.values[1])}|${String(c.values[2])}|${String(c.values[3])}`),
    );
    expect(written.has('warehouse|procurement.receipt.confirm|all')).toBe(true);
    expect(written.has('operations_officer|procurement.pr.create|own')).toBe(true);
    expect(written.has('procurement|procurement.po.issue|all')).toBe(true);
    // Kuu D03: there is no receiver role.
    expect([...written].some((w) => w.startsWith('receiver|'))).toBe(false);
  });
});

describe('seedKernelRows: dev vendor and department (SEED-2)', () => {
  const personas: DevPersona[] = [
    {
      personaKey: 'procurement',
      zitadelUserId: 'z-proc',
      email: 'procurement@dev.bos.test',
      displayName: 'Dev Procurement',
    },
    {
      personaKey: 'management',
      zitadelUserId: 'z-mgmt',
      email: 'management@dev.bos.test',
      displayName: 'Dev Management',
    },
    {
      personaKey: 'depthead',
      zitadelUserId: 'z-head',
      email: 'depthead@dev.bos.test',
      displayName: 'Dev Department Head',
    },
    {
      personaKey: 'founder',
      zitadelUserId: 'z-founder',
      email: 'founder@dev.bos.test',
      displayName: 'Dev Founder',
    },
    {
      personaKey: 'warehouse',
      zitadelUserId: 'z-warehouse',
      email: 'warehouse@dev.bos.test',
      displayName: 'Dev Warehouse',
    },
    // U20a phase 2: the Sales and Marketing department people.
    ...[
      'sales',
      'sales2',
      'salesmgr',
      'saleshead',
      'marketing',
      'marketingmgr',
      'marketinghead',
    ].map((key) => ({
      personaKey: key,
      zitadelUserId: `z-${key}`,
      email: `${key}@dev.bos.test`,
      displayName: `Dev ${key}`,
    })),
  ];
  const userIds: Record<string, string> = {
    'z-proc': 'u-proc',
    'z-mgmt': 'u-mgmt',
    'z-head': 'u-head',
    'z-warehouse': 'u-warehouse',
    ...Object.fromEntries(
      [
        'sales',
        'sales2',
        'salesmgr',
        'saleshead',
        'marketing',
        'marketingmgr',
        'marketinghead',
      ].map((key) => [`z-${key}`, `u-${key}`]),
    ),
  };

  /** The lookups the dev step reads back; every write is scripted by `writes`. */
  const withLookups =
    (writes: Script): Script =>
    (call) => {
      const { text } = call;
      if (text.startsWith('SELECT id FROM app.idp_orgs')) return { rows: [{ id: 'idp-staff' }] };
      if (text.startsWith('SELECT id, zitadel_user_id FROM app.users')) {
        return {
          rows: Object.entries(userIds).map(([zitadel, id]) => ({ id, zitadel_user_id: zitadel })),
        };
      }
      // Keyed by code, so the foreign parties' rows are told apart from CUST-DEV's and VEND-DEV's.
      if (text.startsWith('SELECT id FROM app.parties')) {
        const code = String(call.values[1]);
        const ids: Record<string, string> = { 'CUST-DEV': 'party-cust', 'VEND-DEV': 'party-vend' };
        return { rows: [{ id: ids[code] ?? `party-${code}` }] };
      }
      // Keyed by name, so a member filed into the wrong department shows up as the wrong id.
      if (text.startsWith('SELECT id FROM app.departments')) {
        return { rows: [{ id: `dept-${String(call.values[2])}` }] };
      }
      return writes(call);
    };
  const writesTo = (calls: Call[], table: string) =>
    calls.filter(
      (c) => c.text.includes(`INTO app.${table} `) || c.text.startsWith(`UPDATE app.${table} `),
    );

  it('looks the vendor and customer up by the party codes the tenancy step creates', () => {
    expect(DEV_VENDOR_PARTY_CODE).toBe(SEED_PARTIES.vendor.code);
    expect(DEV_CUSTOMER_PARTY_CODE).toBe(SEED_PARTIES.customer.code);
    expect(SEED_PARTIES.foreignCustomer).toEqual({
      code: DEV_FOREIGN_CUSTOMER.code,
      name: DEV_FOREIGN_CUSTOMER.name,
    });
    expect(SEED_PARTIES.foreignVendor).toEqual({
      code: DEV_FOREIGN_VENDOR.code,
      name: DEV_FOREIGN_VENDOR.name,
    });
    // The foreign parties have no ZITADEL org, so the tenancy step does not write them.
    const codes = tenancySeed({ staff: 's', customer: 'c', vendor: 'v' }).idpOrgs.map(
      (o) => o.party?.code,
    );
    expect(codes).not.toContain(DEV_FOREIGN_CUSTOMER.code);
    expect(codes).not.toContain(DEV_FOREIGN_VENDOR.code);
  });

  it('writes nothing for people, departments, vendors or customers when no personas are passed', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope);
    for (const table of [
      'users',
      'user_entities',
      'departments',
      'vendors',
      'vendor_accounts',
      'customers',
      'customer_contacts',
      'customer_contact_phones',
      'party_accounts',
      'parties',
    ]) {
      expect(writesTo(calls, table)).toEqual([]);
    }
  });

  it('upserts procurement, management, the department head, warehouse and the Sales and Marketing people in the staff IdP org', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const users = writesTo(calls, 'users');
    expect(users.map((c) => c.values)).toEqual([
      ['tenant-1', 'idp-staff', 'z-proc', 'procurement@dev.bos.test', 'Dev Procurement'],
      ['tenant-1', 'idp-staff', 'z-mgmt', 'management@dev.bos.test', 'Dev Management'],
      ['tenant-1', 'idp-staff', 'z-head', 'depthead@dev.bos.test', 'Dev Department Head'],
      ['tenant-1', 'idp-staff', 'z-warehouse', 'warehouse@dev.bos.test', 'Dev Warehouse'],
      ...[
        'sales',
        'sales2',
        'salesmgr',
        'saleshead',
        'marketing',
        'marketingmgr',
        'marketinghead',
      ].map((key) => ['tenant-1', 'idp-staff', `z-${key}`, `${key}@dev.bos.test`, `Dev ${key}`]),
    ]);
    for (const c of users) expect(c.text).toContain('ON CONFLICT (zitadel_user_id) DO NOTHING');
  });

  it('gives each of them a TR membership with their own role, only when they have none', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const memberships = calls.filter((c) => c.text.includes('INTO app.user_entities'));
    expect(memberships.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', 'u-proc', ['procurement']],
      ['tenant-1', 'org-1', 'u-mgmt', ['management']],
      ['tenant-1', 'org-1', 'u-head', ['operations_officer']],
      ['tenant-1', 'org-1', 'u-warehouse', ['warehouse']],
      ['tenant-1', 'org-1', 'u-sales', ['sales']],
      ['tenant-1', 'org-1', 'u-sales2', ['sales']],
      ['tenant-1', 'org-1', 'u-salesmgr', ['sales']],
      ['tenant-1', 'org-1', 'u-saleshead', ['sales']],
      ['tenant-1', 'org-1', 'u-marketing', ['marketing']],
      ['tenant-1', 'org-1', 'u-marketingmgr', ['marketing']],
      ['tenant-1', 'org-1', 'u-marketinghead', ['marketing']],
    ]);
    for (const c of memberships) {
      expect(c.text).toContain('WHERE NOT EXISTS');
      expect(c.text).toContain('ON CONFLICT (tenant_id, organization_id, user_id) DO NOTHING');
    }
  });

  it('creates Operations, Sales and Marketing, each headed by its head persona', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const inserts = calls.filter((c) => c.text.includes('INTO app.departments'));
    expect(inserts.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', 'Operations', 'u-head'],
      ['tenant-1', 'org-1', 'Sales', 'u-saleshead'],
      ['tenant-1', 'org-1', 'Marketing', 'u-marketinghead'],
    ]);
    for (const c of inserts) expect(c.text).toContain('WHERE NOT EXISTS');
    const heads = calls.filter((c) => c.text.startsWith('UPDATE app.departments'));
    expect(heads.map((c) => c.values)).toEqual(inserts.map((c) => c.values));
    for (const c of heads) expect(c.text).toContain('head_user_id IS DISTINCT FROM');
  });

  it('files each member in its own department at its level: depthead heads Operations, sales is Sales staff', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const filed = calls.filter((c) => c.text.startsWith('UPDATE app.user_entities'));
    expect(filed.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', 'u-proc', 'dept-Operations', 'staff'],
      ['tenant-1', 'org-1', 'u-head', 'dept-Operations', 'head'],
      ['tenant-1', 'org-1', 'u-sales', 'dept-Sales', 'staff'],
      ['tenant-1', 'org-1', 'u-sales2', 'dept-Sales', 'staff'],
      ['tenant-1', 'org-1', 'u-salesmgr', 'dept-Sales', 'manager'],
      ['tenant-1', 'org-1', 'u-saleshead', 'dept-Sales', 'head'],
      ['tenant-1', 'org-1', 'u-marketing', 'dept-Marketing', 'staff'],
      ['tenant-1', 'org-1', 'u-marketingmgr', 'dept-Marketing', 'manager'],
      ['tenant-1', 'org-1', 'u-marketinghead', 'dept-Marketing', 'head'],
    ]);
    for (const c of filed) {
      expect(c.text).toContain('department_id IS DISTINCT FROM');
      expect(c.text).toContain('level IS DISTINCT FROM');
    }
    // Every DEV_DEPARTMENTS head is also filed there at level head, so the 0079 triggers have nothing to fix up.
    for (const d of DEV_DEPARTMENTS) {
      expect(d.members).toContainEqual({ key: d.headKey, level: 'head' });
    }
  });

  it('writes and locks each department before filing its members (D55-8 lock order)', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    for (const name of ['Operations', 'Sales', 'Marketing']) {
      const own = (c: Call) => c.values[2] === name;
      const insert = calls.findIndex((c) => c.text.includes('INTO app.departments') && own(c));
      const head = calls.findIndex((c) => c.text.startsWith('UPDATE app.departments') && own(c));
      const lock = calls.findIndex(
        (c) => c.text.startsWith('SELECT id FROM app.departments') && own(c),
      );
      expect(calls[lock]?.text).toContain('FOR UPDATE');
      const members = calls
        .map((c, i) => ({ c, i }))
        .filter(
          ({ c }) =>
            c.text.startsWith('UPDATE app.user_entities') && c.values[3] === `dept-${name}`,
        )
        .map(({ i }) => i);
      expect(members.length, name).toBeGreaterThan(0);
      expect(insert, name).toBeLessThan(head);
      expect(head, name).toBeLessThan(lock);
      expect(lock, name).toBeLessThan(Math.min(...members));
    }
  });

  it('bumps authz_versions after filing people, so cached memberships drop; not when nothing moved', async () => {
    // Grants unchanged (nothingChanged), people filed (every UPDATE app.user_entities changes a row).
    const filedOnly: Script = (call) =>
      call.text.startsWith('UPDATE app.user_entities') ? { rowCount: 1 } : nothingChanged(call);
    const { client, calls } = fakeClient(withLookups(filedOnly));
    await seedKernelRows(client, scope, personas);
    const bumps = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.text.includes('INTO app.authz_versions'));
    expect(bumps).toHaveLength(1);
    const lastFiled = calls.findLastIndex((c) => c.text.startsWith('UPDATE app.user_entities'));
    expect(bumps[0]?.i).toBeGreaterThan(lastFiled);
    expect(bumps[0]?.c.values).toEqual(['tenant-1']);

    const rerun = fakeClient(withLookups(nothingChanged));
    expect(await seedKernelRows(rerun.client, scope, personas)).toBe(0);
    expect(rerun.calls.some((c) => c.text.includes('INTO app.authz_versions'))).toBe(false);
  });

  it('never writes role_permission_levels: the engine derives default level grants until Settings saves', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    expect(calls.some((c) => c.text.includes('role_permission_levels'))).toBe(false);
  });

  it('seeds VEND-DEV as an approved NP company vendor made by procurement and approved by management', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const vendor = calls.find((c) => c.text.includes('INTO app.vendors'));
    expect(vendor?.values).toEqual([
      'tenant-1',
      'party-vend',
      '123456789',
      'u-proc',
      'u-mgmt',
      'Teku Road 4',
      'Kathmandu',
    ]);
    expect(vendor?.text).toContain('address_line, address_city');
    expect(vendor?.values[2]).toMatch(/^[0-9]{9}$/);
    expect(vendor?.text).toContain("'company'");
    expect(vendor?.text).toContain("'NP'");
    expect(vendor?.text).toContain("'approved'");
    expect(vendor?.text).toContain('ON CONFLICT (id) DO NOTHING');
    // The party it hangs on is the VEND-DEV vendor party, found by code and kind.
    const party = calls.find(
      (c) => c.text.startsWith('SELECT id FROM app.parties') && c.text.includes("kind = 'vendor'"),
    );
    expect(party?.values).toEqual(['tenant-1', 'VEND-DEV']);
    expect(party?.text).toContain("kind = 'vendor'");
  });

  it('seeds the second vendor as approved and the vendor awaiting KYC as pending_kyc, each on its own party, PAN and TR account', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const vendors = calls.filter((c) => c.text.includes('INTO app.vendors'));
    // VEND-DEV, the two extra vendors, then the foreign vendor.
    const byParty = (id: string) => vendors.find((c) => c.values[1] === id);
    const second = byParty('party-VEND-DEV2');
    const pending = byParty('party-VEND-DEVKYC');
    expect(second?.values).toEqual([
      'tenant-1',
      'party-VEND-DEV2',
      '234567891',
      'u-proc',
      'u-mgmt',
      'Teku Road 4',
      'Kathmandu',
      'approved',
    ]);
    expect(pending?.values).toEqual([
      'tenant-1',
      'party-VEND-DEVKYC',
      '345678912',
      'u-proc',
      'u-mgmt',
      'Teku Road 4',
      'Kathmandu',
      'pending_kyc',
    ]);
    // Only an approved vendor gets approved_by (vendors_approval_check), and a re-run inserts nothing twice.
    expect(second?.text).toContain("CASE WHEN $8 = 'approved' THEN $5::uuid END");
    expect(second?.text).toContain('ON CONFLICT (id) DO NOTHING');
    // Both parties are looked up by code and kind, the codes the tenancy step writes.
    const parties = calls
      .filter((c) => c.text.startsWith('SELECT id FROM app.parties') && c.text.includes("'vendor'"))
      .map((c) => c.values[1]);
    expect(parties).toEqual(expect.arrayContaining(['VEND-DEV2', 'VEND-DEVKYC']));
    for (const v of EXTRA_VENDORS) {
      expect(SEED_PARTIES.vendor.code).not.toBe(v.partyCode);
      const account = calls.find(
        (c) =>
          c.text.includes('INTO app.vendor_accounts') && c.values[2] === `party-${v.partyCode}`,
      );
      expect(account?.values, v.key).toEqual([
        'tenant-1',
        'org-1',
        `party-${v.partyCode}`,
        'NET30',
      ]);
    }
  });

  it('gives only the vendor awaiting KYC a draft KYB case with the vendor checklist, every item missing and the three owed documents required', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const cases = writesTo(calls, 'verification_cases');
    expect(cases).toHaveLength(1);
    const kyb = cases[0];
    expect(kyb?.values[0]).toBe('tenant-1');
    expect(kyb?.values[1]).toBe('party-VEND-DEVKYC');
    expect(kyb?.text).toContain("'vendor', 'draft'");
    expect(kyb?.text).toContain('ON CONFLICT (tenant_id, party_id) DO NOTHING');
    const checklist = JSON.parse(String(kyb?.values[2])) as {
      key: string;
      required: boolean;
      status: string;
      documentId: string | null;
    }[];
    expect(checklist.map((i) => i.key)).toEqual([...VENDOR_CHECKLIST_ITEM_KEYS]);
    expect(checklist.every((i) => i.status === 'missing' && i.documentId === null)).toBe(true);
    expect(checklist.filter((i) => i.required).map((i) => i.key)).toEqual([
      'pan_certificate',
      'tax_clearance',
      'bank_proof',
    ]);
    // The required keys are the contract's, the same list the API's new vendor case uses.
    expect(checklist.filter((i) => i.required).map((i) => i.key)).toEqual([
      ...REQUIRED_VENDOR_CHECKLIST_KEYS,
    ]);
    // The portal upload needs a pan_certificate item to attach to.
    expect(checklist.some((i) => i.key === 'pan_certificate')).toBe(true);
  });

  it('names the vendor and the PAN when a vendor made by hand already holds a seeded PAN, instead of failing on the unique index', async () => {
    const vendor = EXTRA_VENDORS[0];
    const { client, calls } = fakeClient((call) => {
      if (call.text.startsWith('SELECT id FROM app.parties'))
        return { rows: [{ id: `party-${call.values[1]}` }] };
      if (call.text.startsWith('SELECT id, legal_name FROM app.vendors'))
        return { rows: [{ id: 'hand-made-1', legal_name: 'Hand Made Traders' }] };
      return { rowCount: 1 };
    });
    await expect(seedExtraVendor(client, scope, vendor, 'creator-1', 'approver-1')).rejects.toThrow(
      new RegExp(`PAN ${vendor.pan} of ${vendor.partyCode} is already held by .*Hand Made Traders`),
    );
    // Nothing is written once the holder is found.
    expect(calls.some((c) => c.text.startsWith('INSERT'))).toBe(false);
  });

  it('writes neither extra vendor, nor a KYB case, without the dev personas (the production path)', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope);
    expect(writesTo(calls, 'vendors')).toEqual([]);
    expect(writesTo(calls, 'verification_cases')).toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.values))).not.toMatch(/VEND-DEV2|VEND-DEVKYC/);
  });

  it('pins the extra vendors party codes to the ones the tenancy step writes', () => {
    const ids = { staff: 's', customer: 'c', vendor: 'v' };
    const seed = tenancySeed(ids, { vendor2: 'o2', vendorpending: 'o3' });
    for (const v of EXTRA_VENDORS) {
      expect(seed.idpOrgs.find((o) => o.party?.code === v.partyCode)?.kind).toBe('vendor');
    }
    // No extra org ids: the three orgs as before.
    expect(tenancySeed(ids).idpOrgs).toHaveLength(3);
  });

  it('seeds CUST-DEV (Dev Customer Co) as an active NPR customer owned by sales, with primary contact and TR account', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);

    const party = calls.find(
      (c) =>
        c.text.startsWith('SELECT id FROM app.parties') && c.text.includes("kind = 'customer'"),
    );
    expect(party?.values).toEqual(['tenant-1', 'CUST-DEV']);

    const customer = calls.find((c) => c.text.includes('INTO app.customers'));
    expect(customer?.values).toEqual([
      'tenant-1',
      'party-cust',
      DEV_CUSTOMER_NAME_NORM,
      'u-sales',
      'NP',
      'Durbar Marg 1',
      'Kathmandu',
    ]);
    // 0191: country, address_line and address_city replace the jsonb address.
    expect(customer?.text).toContain('country, address_line, address_city');
    expect(customer?.text).not.toMatch(/\baddress\)|jsonb/);
    expect(customer?.text).toContain("'active'");
    expect(customer?.text).toContain("'NPR'");
    expect(customer?.text).toContain('ON CONFLICT (id) DO NOTHING');

    const contact = calls.find((c) => c.text.includes('INTO app.customer_contacts'));
    expect(contact?.values).toEqual([
      'tenant-1',
      'party-cust',
      'Dev Customer',
      'customer@dev.bos.test',
    ]);
    expect(contact?.text).toContain('WHERE NOT EXISTS');
    expect(contact?.text).toContain('is_primary');

    const account = calls.find((c) => c.text.includes('INTO app.party_accounts'));
    expect(account?.values).toEqual(['tenant-1', 'org-1', 'party-cust', 'u-sales', 'NET30']);
    expect(account?.text).toContain("'NPR'");
    expect(account?.text).toContain(
      'ON CONFLICT (tenant_id, organization_id, party_id) DO NOTHING',
    );

    const at = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(at('INTO app.customers')).toBeGreaterThan(at('INTO app.user_entities'));
    expect(at('INTO app.customer_contacts')).toBeGreaterThan(at('INTO app.customers'));
    expect(at('INTO app.party_accounts')).toBeGreaterThan(at('INTO app.customers'));
    expect(at('INTO app.party_accounts')).toBeGreaterThan(at('INTO app.payment_terms'));
  });

  it("gives CUST-DEV's primary contact two numbers in two countries, a Nepal mobile first and primary", async () => {
    // The real consumer's rule: each number is valid for its own country.
    for (const p of DEV_CUSTOMER_CONTACT_PHONES) {
      expect(phoneProblem(p.country as CountryCode, p.e164), p.e164).toBeNull();
    }
    expect(DEV_CUSTOMER_CONTACT_PHONES.filter((p) => p.isPrimary)).toHaveLength(1);

    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const phones = writesTo(calls, 'customer_contact_phones');
    expect(phones).toHaveLength(1);
    expect(phones[0]?.values).toEqual([
      'tenant-1',
      'party-cust',
      ['NP', 'US'],
      ['+9779812345678', '+14155552671'],
      ['mobile', 'work'],
      [0, 1],
      [true, false],
    ]);
    // Only on CUST-DEV's primary contact, and only while it has no number at all (a hand edit is kept).
    expect(phones[0]?.text).toContain('cc.customer_id = $2::uuid AND cc.is_primary');
    expect(phones[0]?.text).toContain('NOT EXISTS');
    expect(phones[0]?.text).not.toContain('phone_e164');
    const at = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(at('INTO app.customer_contact_phones')).toBeGreaterThan(
      at('INTO app.customer_contacts'),
    );
  });

  it('seeds a US customer with no PAN, a USD account and a full address', async () => {
    expect(DEV_FOREIGN_CUSTOMER.address.country).not.toBe('NP');
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);

    const party = writesTo(calls, 'parties');
    expect(party.map((c) => c.values)).toEqual([
      ['tenant-1', 'customer', 'CUST-US-DEV', 'Acme Robotics Inc'],
      ['tenant-1', 'vendor', 'VEND-IN-DEV', 'Mumbai Industrial Supplies Pvt Ltd'],
    ]);
    for (const c of party) expect(c.text).toContain('ON CONFLICT (tenant_id, code) DO NOTHING');

    const customers = writesTo(calls, 'customers');
    expect(customers).toHaveLength(2);
    expect(customers[1]?.values).toEqual([
      'tenant-1',
      'party-CUST-US-DEV',
      'acme robotics',
      'u-sales',
      'USD',
      'US',
      '500 Market Street, Suite 200',
      'San Francisco',
    ]);
    // No PAN column at all: pan_vat_no stays NULL.
    expect(customers[1]?.text).not.toContain('pan_vat_no');
    expect(customers[1]?.text).toContain('ON CONFLICT (id) DO NOTHING');

    const contacts = writesTo(calls, 'customer_contacts');
    expect(contacts).toHaveLength(2);
    expect(contacts[1]?.values).toEqual([
      'tenant-1',
      'party-CUST-US-DEV',
      'Jordan Lee',
      'jordan.lee@acme-robotics.example',
      'US',
    ]);
    expect(contacts[1]?.text).toContain('WHERE NOT EXISTS');

    const accounts = writesTo(calls, 'party_accounts');
    expect(accounts[1]?.values).toEqual([
      'tenant-1',
      'org-1',
      'party-CUST-US-DEV',
      'u-sales',
      'USD',
      'NET30',
    ]);
  });

  it('seeds an approved Indian vendor (kind foreign) with an address and a loose tax id', async () => {
    // Loose, not a Nepal PAN: the DB's vendors_pan_check and vendors_pan_format_check accept it for a foreign vendor, and
    // it passes the contracts' loose tax-id shape. (CreateVendorBodySchema still asks every vendor PAN for 9 digits.)
    expect(PanVatNoSchema.safeParse(DEV_FOREIGN_VENDOR.pan).success).toBe(true);
    expect(DEV_FOREIGN_VENDOR.pan).not.toMatch(/^[0-9]{9}$/);
    expect(DEV_FOREIGN_VENDOR.pan).toMatch(/^[A-Z0-9-]{5,20}$/);
    expect(nepalPanProblem(DEV_FOREIGN_VENDOR.address.country, DEV_FOREIGN_VENDOR.pan)).toBeNull();
    expect(nepalPanProblem('NP', DEV_FOREIGN_VENDOR.pan)).not.toBeNull();

    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const vendors = writesTo(calls, 'vendors');
    // VEND-DEV, this one, then the two extra vendors (their own tests are above).
    expect(vendors).toHaveLength(4);
    expect(vendors[1]?.values).toEqual([
      'tenant-1',
      'party-VEND-IN-DEV',
      'AAACM1234F',
      'IN',
      'Plot 12, MIDC, Andheri East',
      'Mumbai',
      'u-proc',
      'u-mgmt',
    ]);
    // vendors_foreign_country_check: kind is foreign exactly when the country is not NP.
    expect(vendors[1]?.text).toContain("'foreign'");
    expect(vendors[1]?.text).toContain("'approved'");
    const lookup = calls.find(
      (c) => c.text.startsWith('SELECT id FROM app.parties') && c.values[1] === 'VEND-IN-DEV',
    );
    expect(lookup?.text).toContain("kind = 'vendor'");

    const accounts = writesTo(calls, 'vendor_accounts');
    expect(accounts[1]?.values).toEqual(['tenant-1', 'org-1', 'party-VEND-IN-DEV', 'INR', 'NET30']);
    // After CUST-DEV and VEND-DEV, so their lookups and inserts keep coming first.
    const at = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(at('INTO app.parties')).toBeGreaterThan(at('INTO app.party_accounts'));
  });

  it('fails clearly, and rolls back, when a foreign party is missing after its insert', async () => {
    const { client, calls } = fakeClient((call) =>
      call.text.startsWith('SELECT id FROM app.parties') && call.values[1] === 'VEND-IN-DEV'
        ? { rows: [] }
        : withLookups(firstRun)(call),
    );
    await expect(seedKernelRows(client, scope, personas)).rejects.toThrow(/VEND-IN-DEV/);
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('gives VEND-DEV an NPR account in TR on the NET30 term, after the payment terms exist', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await seedKernelRows(client, scope, personas);
    const account = calls.find((c) => c.text.includes('INTO app.vendor_accounts'));
    expect(account?.values).toEqual(['tenant-1', 'org-1', 'party-vend', 'NET30']);
    expect(account?.text).toContain("'NPR'");
    expect(account?.text).toContain(
      'ON CONFLICT (tenant_id, organization_id, vendor_id) DO NOTHING',
    );
    const at = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(at('INTO app.vendor_accounts')).toBeGreaterThan(at('INTO app.payment_terms'));
    expect(at('INTO app.vendors')).toBeGreaterThan(at('INTO app.user_entities'));
    expect(at('INTO app.user_entities')).toBeGreaterThan(at('INTO app.users'));
    expect(at('INTO app.departments')).toBeGreaterThan(at('INTO app.users'));
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('counts the new rows on a first run and changes nothing on a second', async () => {
    const without = await seedKernelRows(fakeClient(withLookups(firstRun)).client, scope);
    const first = await seedKernelRows(fakeClient(withLookups(firstRun)).client, scope, personas);
    expect(first).toBeGreaterThan(without);
    const second = await seedKernelRows(
      fakeClient(withLookups(nothingChanged)).client,
      scope,
      personas,
    );
    expect(second).toBe(0);
  });

  it('refuses before BEGIN when a persona it needs was not passed', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await expect(
      seedKernelRows(
        client,
        scope,
        personas.filter((p) => p.personaKey !== 'depthead'),
      ),
    ).rejects.toThrow(/depthead/);
    expect(calls).toEqual([]);
  });

  it('requires the Sales and Marketing department people before BEGIN', async () => {
    for (const key of ['sales', 'saleshead', 'marketingmgr']) {
      const { client, calls } = fakeClient(withLookups(firstRun));
      await expect(
        seedKernelRows(
          client,
          scope,
          personas.filter((p) => p.personaKey !== key),
        ),
      ).rejects.toThrow(new RegExp(`"${key}"`));
      expect(calls).toEqual([]);
    }
  });

  it('requires the warehouse persona before BEGIN so receipts have an entity member', async () => {
    const { client, calls } = fakeClient(withLookups(firstRun));
    await expect(
      seedKernelRows(
        client,
        scope,
        personas.filter((p) => p.personaKey !== 'warehouse'),
      ),
    ).rejects.toThrow(/warehouse/);
    expect(calls).toEqual([]);
  });

  it('rolls back when the vendor insert fails', async () => {
    const { client, calls } = fakeClient(
      withLookups((call) =>
        call.text.includes('INTO app.vendors ')
          ? (new Error('vendors_party_fk') as unknown as Reply)
          : firstRun(call),
      ),
    );
    await expect(seedKernelRows(client, scope, personas)).rejects.toThrow('vendors_party_fk');
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('fails clearly, and rolls back, when the VEND-DEV party, CUST-DEV party or staff IdP org is missing', async () => {
    const missing =
      (predicate: (call: Call) => boolean): Script =>
      (call) =>
        predicate(call) ? { rows: [] } : withLookups(firstRun)(call);
    const noVendor = fakeClient(
      missing(
        (c) =>
          c.text.startsWith('SELECT id FROM app.parties') && c.text.includes("kind = 'vendor'"),
      ),
    );
    await expect(seedKernelRows(noVendor.client, scope, personas)).rejects.toThrow(/VEND-DEV/);
    expect(noVendor.calls.at(-1)?.text).toBe('ROLLBACK');
    const noCustomer = fakeClient(
      missing(
        (c) =>
          c.text.startsWith('SELECT id FROM app.parties') && c.text.includes("kind = 'customer'"),
      ),
    );
    await expect(seedKernelRows(noCustomer.client, scope, personas)).rejects.toThrow(/CUST-DEV/);
    expect(noCustomer.calls.at(-1)?.text).toBe('ROLLBACK');
    const noOrg = fakeClient(missing((c) => c.text.startsWith('SELECT id FROM app.idp_orgs')));
    await expect(seedKernelRows(noOrg.client, scope, personas)).rejects.toThrow(/staff/);
    expect(noOrg.calls.at(-1)?.text).toBe('ROLLBACK');
  });
});

describe('seedKernelRows: stale role grants (R25)', () => {
  /** First run against a table that still holds one grant the defaults no longer list. */
  const staleRow: Script = (call) =>
    call.text.startsWith('DELETE FROM app.role_permissions')
      ? { rowCount: 1, rows: [{ id: 'stale-1' }] }
      : nothingChanged(call);

  it('deletes role_permissions rows the defaults no longer list, then bumps authz_versions', async () => {
    const { client, calls } = fakeClient(staleRow);
    const changed = await seedKernelRows(client, scope);

    const del = calls.filter((c) => c.text.startsWith('DELETE FROM app.role_permissions'));
    expect(del).toHaveLength(1);
    // The stale DELETE filters on tenant_id only: role_permissions has no organization_id any more.
    expect(del[0]?.text).not.toContain('organization_id');
    expect(del[0]?.values[0]).toBe('tenant-1');
    expect(del[0]?.values).toHaveLength(3);
    // The keep-list holds every default (role, permission) pair, in two parallel arrays.
    const [roles, permissions] = [del[0]?.values[1], del[0]?.values[2]] as [string[], string[]];
    const kept = new Set(roles.map((role, i) => `${role}|${String(permissions[i])}`));
    expect(kept.size).toBe(grantCount);
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const permission of Object.keys(grants)) {
        expect(kept.has(`${role}|${permission}`)).toBe(true);
      }
    }

    const index = (needle: string) => calls.findIndex((c) => c.text.includes(needle));
    expect(index('DELETE FROM app.role_permissions')).toBeGreaterThan(
      index('INTO app.role_permissions'),
    );
    expect(index('INTO app.authz_versions')).toBeGreaterThan(
      index('DELETE FROM app.role_permissions'),
    );
    const bump = calls.find((c) => c.text.includes('INTO app.authz_versions'));
    expect(bump?.text).toContain('(tenant_id, version)');
    expect(bump?.text).toContain('ON CONFLICT (tenant_id) DO UPDATE');
    expect(bump?.text).not.toContain('organization_id');
    expect(bump?.values).toEqual(['tenant-1']);
    // Only the deleted row counts: this fake answers the authz bump with rowCount 0.
    expect(changed).toBe(1);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('only ever updates or deletes seeded rows, so a Founder-made grant (seeded = false) is left alone', async () => {
    const { client, calls } = fakeClient(nothingChanged);
    await seedKernelRows(client, scope);
    const upserts = calls.filter((c) => c.text.includes('INTO app.role_permissions'));
    for (const c of upserts) {
      expect(c.text).toContain('VALUES ($1, $2, $3, $4, true)');
      expect(c.text.split('DO UPDATE')[1]).toContain('AND role_permissions.seeded');
    }
    const del = calls.find((c) => c.text.startsWith('DELETE FROM app.role_permissions'));
    expect(del?.text).toContain('AND seeded');
  });

  it('deletes nothing and bumps nothing on a second run', async () => {
    const { client, calls } = fakeClient(nothingChanged);
    expect(await seedKernelRows(client, scope)).toBe(0);
    expect(calls.filter((c) => c.text.startsWith('DELETE'))).toHaveLength(1);
    expect(calls.some((c) => c.text.includes('INTO app.authz_versions'))).toBe(false);
  });
});

describe('PgTenancyStore (R5, ADR 0027 section 11)', () => {
  /** A store over one fake client; counts how often the connection is closed. */
  function storeOver(script: Script) {
    const fake = fakeClient(script);
    let closed = 0;
    const store = new PgTenancyStore(() =>
      Promise.resolve({
        client: fake.client,
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    );
    return { store, calls: fake.calls, closed: () => closed };
  }
  const seed = tenancySeed({ staff: 'z-staff', customer: 'z-cust', vendor: 'z-vend' });
  const inserts = (calls: Call[], table: string) =>
    calls.filter((c) => c.text.startsWith(`INSERT INTO app.${table} `));
  const firstWrite = (calls: Call[]) =>
    calls.findIndex((c) => /^(INSERT|UPDATE|DELETE)/.test(c.text));
  const actorOf = (calls: Call[]) => calls.find((c) => c.text.startsWith('SELECT set_config'));

  /** Fresh database: no tenant, entity or party yet; every write changes one row. */
  const fresh: Script = ({ text, values }) => {
    if (text.startsWith('SELECT id FROM app.parties'))
      return { rows: [{ id: `party-${String(values[1])}` }] };
    if (text.startsWith('INSERT') || text.startsWith('UPDATE')) return { rowCount: 1 };
    return undefined;
  };
  /** Everything exists: the staff idp_org names the tenant, the parties are linked; writes are no-ops. */
  const existing =
    (partyOf: Record<string, string | null>): Script =>
    ({ text, values }) => {
      if (text.startsWith('SELECT tenant_id FROM app.idp_orgs'))
        return { rows: [{ tenant_id: 't-1' }] };
      if (text.startsWith('SELECT id FROM app.organizations')) return { rows: [{ id: 'e-1' }] };
      if (text.startsWith('SELECT party_id FROM app.idp_orgs'))
        return { rows: [{ party_id: partyOf[String(values[0])] ?? null }] };
      if (text.startsWith('SELECT id FROM app.parties'))
        return { rows: [{ id: `party-${String(values[1])}` }] };
      return undefined;
    };

  it('first run writes the tenant, the TR entity, both parties and three idp_orgs, after the seed actor', async () => {
    const { store, calls, closed } = storeOver(fresh);
    const changed = await store.upsertTenancy(seed, 'corr-9');

    expect(calls[0]?.text).toBe('BEGIN');
    const actorAt = calls.findIndex((c) => c.text.startsWith('SELECT set_config'));
    expect(actorAt).toBeGreaterThan(0);
    expect(actorAt).toBeLessThan(firstWrite(calls));
    const [tenant] = inserts(calls, 'tenants');
    const [entity, ...moreEntities] = inserts(calls, 'organizations');
    expect(moreEntities).toEqual([]);
    // The audit fallback (bos.organization_id) names the entity this transaction writes.
    expect(actorOf(calls)?.values).toEqual([
      tenant?.values[0],
      entity?.values[0],
      'seed',
      'seed',
      'corr-9',
      '',
      '',
    ]);

    expect(entity?.values).toEqual([
      entity?.values[0],
      tenant?.values[0],
      'TR',
      'Techrida',
      'Techrida Pvt. Ltd.',
    ]);
    expect(entity?.text).toContain('VALUES ($1, $2, $1, $3, $4, $5, true)');
    expect(entity?.text).toContain('ON CONFLICT (tenant_id, code) DO UPDATE');
    expect(entity?.text).toContain('IS DISTINCT FROM');
    // is_default is set on insert only, never by the DO UPDATE.
    expect(entity?.text.split('DO UPDATE')[1]).not.toContain('is_default');
    expect(entity?.text).not.toMatch(/zitadel_org_id|kind/);

    const t = tenant?.values[0];
    const parties = inserts(calls, 'parties');
    expect(parties.map((c) => c.values)).toEqual([
      [t, 'customer', 'CUST-DEV', 'Dev Customer Co'],
      [t, 'vendor', 'VEND-DEV', 'Dev Vendor Co'],
    ]);
    for (const p of parties) {
      expect(p.text).toContain('ON CONFLICT (tenant_id, code) DO UPDATE');
      expect(p.text).toContain('IS DISTINCT FROM');
      expect(p.text).not.toContain('RETURNING');
    }
    const idpOrgs = inserts(calls, 'idp_orgs');
    expect(idpOrgs.map((c) => c.values)).toEqual([
      [t, 'z-staff', 'staff', null, 'Techrida Staff'],
      [t, 'z-cust', 'customer', 'party-CUST-DEV', 'Dev Customer Co'],
      [t, 'z-vend', 'vendor', 'party-VEND-DEV', 'Dev Vendor Co'],
    ]);
    for (const o of idpOrgs) {
      expect(o.text).toContain('ON CONFLICT (zitadel_org_id) DO UPDATE');
      expect(o.text).toContain('IS DISTINCT FROM');
    }
    expect(calls.some((c) => c.text.startsWith('UPDATE app.parties'))).toBe(false);
    expect(calls.at(-1)?.text).toBe('COMMIT');
    // tenant + entity + 2 parties + 3 idp_orgs
    expect(changed).toBe(7);
    expect(closed()).toBe(1);
  });

  it('second run changes nothing and reuses the staff tenant and the TR entity', async () => {
    const { store, calls } = storeOver(existing({ 'z-cust': 'p-c', 'z-vend': 'p-v' }));
    expect(await store.upsertTenancy(seed, 'corr-9')).toBe(0);

    const staffTenant = calls.find((c) => c.text.startsWith('SELECT tenant_id FROM app.idp_orgs'));
    expect(staffTenant?.values).toEqual(['z-staff']);
    const entityId = calls.find((c) => c.text.startsWith('SELECT id FROM app.organizations'));
    expect(entityId?.values).toEqual(['t-1', 'TR']);
    expect(actorOf(calls)?.values.slice(0, 2)).toEqual(['t-1', 'e-1']);
    expect(calls.some((c) => c.text.includes('INTO app.tenants'))).toBe(false);
    expect(inserts(calls, 'organizations')[0]?.values[0]).toBe('e-1');
    expect(inserts(calls, 'idp_orgs').map((c) => c.values[3])).toEqual([null, 'p-c', 'p-v']);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('re-codes a migrated party in place instead of inserting a duplicate', async () => {
    const migrated = existing({ 'z-cust': 'migrated-cust', 'z-vend': 'migrated-vend' });
    const { store, calls } = storeOver((call) =>
      call.text.startsWith('UPDATE app.parties') ? { rowCount: 1 } : migrated(call),
    );
    const changed = await store.upsertTenancy(seed, 'corr-9');

    const updates = calls.filter((c) => c.text.startsWith('UPDATE app.parties'));
    expect(updates.map((c) => c.values)).toEqual([
      ['migrated-cust', 'CUST-DEV', 'Dev Customer Co'],
      ['migrated-vend', 'VEND-DEV', 'Dev Vendor Co'],
    ]);
    for (const u of updates) {
      expect(u.text).toContain('SET code = $2');
      expect(u.text).toContain('IS DISTINCT FROM');
    }
    expect(calls.some((c) => c.text.startsWith('INSERT INTO app.parties'))).toBe(false);
    expect(inserts(calls, 'idp_orgs').map((c) => c.values[3])).toEqual([
      null,
      'migrated-cust',
      'migrated-vend',
    ]);
    expect(changed).toBe(2);
  });

  it('falls back to the tenant of app.organizations when no staff idp_org exists yet', async () => {
    const { store, calls } = storeOver((call) =>
      call.text.startsWith('SELECT tenant_id FROM app.organizations')
        ? { rows: [{ tenant_id: 't-old' }] }
        : fresh(call),
    );
    await store.upsertTenancy(seed, 'corr-9');
    expect(actorOf(calls)?.values[0]).toBe('t-old');
    expect(calls.some((c) => c.text.includes('INTO app.tenants'))).toBe(false);
  });

  it('rolls back and closes the connection when a write fails', async () => {
    const { store, calls, closed } = storeOver((call) =>
      call.text.startsWith('INSERT INTO app.idp_orgs')
        ? (new Error('fk violated') as unknown as Reply)
        : fresh(call),
    );
    await expect(store.upsertTenancy(seed, 'corr-9')).rejects.toThrow('fk violated');
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
    expect(closed()).toBe(1);
  });

  it('seeds kernel rows for the staff tenant default entity; a second run returns 0', async () => {
    const lookup = (call: Call): Reply | undefined =>
      call.text.startsWith('SELECT o.id, o.tenant_id FROM app.idp_orgs i JOIN app.organizations o')
        ? { rows: [{ id: 'org-uuid', tenant_id: 'tenant-uuid' }] }
        : undefined;
    const first = storeOver((call) => lookup(call) ?? firstRun(call));
    expect(await first.store.seedKernel('z-staff', 'corr-9')).toBeGreaterThan(0);
    expect(first.calls[0]?.values).toEqual(['z-staff']);
    expect(first.calls[0]?.text).toContain('o.tenant_id = i.tenant_id AND o.is_default');
    // role_permissions is tenant-scoped, so the grant tuple no longer carries the entity.
    const grant = first.calls.find((c) => c.text.includes('INTO app.role_permissions'));
    expect(grant?.values[0]).toBe('tenant-uuid');
    const definitions = first.calls.filter((c) => c.text.includes('INTO app.workflow_definitions'));
    expect(definitions.map((c) => c.values)).toEqual([
      ['tenant-uuid', 'org-uuid', 'test_memo', 'Test memo approval', 'test_memo'],
      [
        'tenant-uuid',
        'org-uuid',
        'quotation_version',
        'Quotation version approval',
        'quotation_version',
      ],
      [
        'tenant-uuid',
        'org-uuid',
        'purchase_request',
        'Purchase request approval',
        'purchase_request',
      ],
      ['tenant-uuid', 'org-uuid', 'pr_commitment', 'Purchase commitment approval', 'pr_commitment'],
      ['tenant-uuid', 'org-uuid', 'po_amendment', 'Purchase order amendment', 'po_amendment'],
      [
        'tenant-uuid',
        'org-uuid',
        'po_vendor_change',
        'Purchase order vendor change',
        'po_vendor_change',
      ],
      [
        'tenant-uuid',
        'org-uuid',
        'emergency_review',
        'Emergency purchase review',
        'emergency_review',
      ],
      ['tenant-uuid', 'org-uuid', 'vendor_bill', 'Vendor bill approval', 'vendor_bill'],
      ['tenant-uuid', 'org-uuid', 'match_exception', 'Match exception approval', 'match_exception'],
      ['tenant-uuid', 'org-uuid', 'payment_request', 'Payment request approval', 'payment_request'],
      ['tenant-uuid', 'org-uuid', 'tax_invoice', 'Tax invoice approval', 'tax_invoice'],
      ['tenant-uuid', 'org-uuid', 'credit_note', 'Credit note approval', 'credit_note'],
      ['tenant-uuid', 'org-uuid', 'debit_note', 'Debit note approval', 'debit_note'],
      ['tenant-uuid', 'org-uuid', 'memo_approver', 'Memo approver', 'memo_approver'],
    ]);
    expect(first.closed()).toBe(1);

    const second = storeOver((call) => lookup(call) ?? nothingChanged(call));
    expect(await second.store.seedKernel('z-staff', 'corr-9')).toBe(0);
  });

  it('hands the dev personas on to the kernel seed, so VEND-DEV and the department get written', async () => {
    const departmentPeople = [
      'sales',
      'sales2',
      'salesmgr',
      'saleshead',
      'marketing',
      'marketingmgr',
      'marketinghead',
    ];
    const lookup = (call: Call): Reply | undefined => {
      if (call.text.startsWith('SELECT o.id, o.tenant_id FROM app.idp_orgs i JOIN'))
        return { rows: [{ id: 'org-uuid', tenant_id: 'tenant-uuid' }] };
      if (call.text.startsWith('SELECT id FROM app.idp_orgs')) return { rows: [{ id: 'idp-1' }] };
      if (call.text.startsWith('SELECT id, zitadel_user_id FROM app.users'))
        return {
          rows: [
            { id: 'u-1', zitadel_user_id: 'z-1' },
            { id: 'u-2', zitadel_user_id: 'z-2' },
            { id: 'u-3', zitadel_user_id: 'z-3' },
            { id: 'u-4', zitadel_user_id: 'z-4' },
            ...departmentPeople.map((key) => ({ id: `u-${key}`, zitadel_user_id: `z-${key}` })),
          ],
        };
      if (call.text.startsWith('SELECT id FROM app.parties')) {
        return {
          rows: [{ id: call.text.includes("kind = 'customer'") ? 'party-cust-1' : 'party-1' }],
        };
      }
      if (call.text.startsWith('SELECT id FROM app.departments')) {
        return { rows: [{ id: `d-${String(call.values[2])}` }] };
      }
      return undefined;
    };
    const person = (personaKey: string, zitadelUserId: string): DevPersona => ({
      personaKey,
      zitadelUserId,
      email: `${personaKey}@dev.bos.test`,
      displayName: personaKey,
    });
    const { store, calls } = storeOver((call) => lookup(call) ?? firstRun(call));
    await store.seedKernel('z-staff', 'corr-9', [
      person('procurement', 'z-1'),
      person('management', 'z-2'),
      person('depthead', 'z-3'),
      person('warehouse', 'z-4'),
      ...departmentPeople.map((key) => person(key, `z-${key}`)),
    ]);
    const vendor = calls.find((c) => c.text.includes('INTO app.vendors'));
    expect(vendor?.values[0]).toBe('tenant-uuid');
    expect(calls.some((c) => c.text.includes('INTO app.vendor_accounts'))).toBe(true);
    const customer = calls.find((c) => c.text.includes('INTO app.customers'));
    expect(customer?.values[0]).toBe('tenant-uuid');
    expect(calls.some((c) => c.text.includes('INTO app.customer_contacts'))).toBe(true);
    expect(calls.some((c) => c.text.includes('INTO app.party_accounts'))).toBe(true);
    expect(
      calls.find((c) => c.text.includes('INTO app.user_entities') && c.values[2] === 'u-4')?.values,
    ).toEqual(['tenant-uuid', 'org-uuid', 'u-4', ['warehouse']]);
  });

  it('fails clearly when the staff org has no idp_org or default entity yet', async () => {
    const { store, closed } = storeOver(() => undefined);
    await expect(store.seedKernel('z-staff', 'corr-9')).rejects.toThrow(
      /no default entity for staff IdP org z-staff/,
    );
    expect(closed()).toBe(1);
  });
});

describe('seedKernelRows: P3 invoice approval workflows and grants', () => {
  const P3_WORKFLOWS = [
    ['tax_invoice', 'Tax invoice approval', TAX_INVOICE_WORKFLOW_SPEC],
    ['credit_note', 'Credit note approval', CREDIT_NOTE_WORKFLOW_SPEC],
    ['debit_note', 'Debit note approval', DEBIT_NOTE_WORKFLOW_SPEC],
  ] as const;

  it.each(P3_WORKFLOWS.slice(1))(
    'keeps the %s spec valid: accountant, then finance, distinct approvers, no amount rules',
    (documentType, _name, rawSpec) => {
      const spec = WorkflowSpecSchema.parse(rawSpec);
      expect(spec.documentType).toBe(documentType);
      expect(spec.distinctApprovers).toBe(true);
      expect(spec.steps.map((s) => [s.id, s.kind, s.role])).toEqual([
        ['accountant', 'role', 'accountant'],
        ['finance', 'role', 'finance'],
      ]);
      expect(spec.rules).toEqual([]);
    },
  );

  it('routes a tax invoice by its source (F1-Q30): Accountant only for a manual one, then Finance for every one', () => {
    const spec = WorkflowSpecSchema.parse(TAX_INVOICE_WORKFLOW_SPEC);
    expect(spec.documentType).toBe('tax_invoice');
    expect(spec.distinctApprovers).toBe(true);
    expect(spec.steps).toEqual([]);
    expect(spec.rules.map((r) => [r.when, r.add.id, r.add.kind, r.add.role, r.position])).toEqual([
      [
        { field: 'fromSchedule', op: 'eq', value: false },
        'accountant',
        'role',
        'accountant',
        'end',
      ],
      [{ field: 'kind', op: 'eq', value: 'tax_invoice' }, 'finance', 'role', 'finance', 'end'],
    ]);
  });

  it('keeps the tax invoice spec word for word with migration 0110', () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../packages/db/migrations/0110_tax_invoice_route.sql', import.meta.url),
      ),
      'utf8',
    );
    const literal = /v_new jsonb := '([^']+)'::jsonb;/.exec(migration)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal ?? 'null')).toEqual(
      JSON.parse(JSON.stringify(WorkflowSpecSchema.parse(TAX_INVOICE_WORKFLOW_SPEC))),
    );
  });

  it("matches migration 0110's old route to the one the seed published before F1-Q30", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../packages/db/migrations/0110_tax_invoice_route.sql', import.meta.url),
      ),
      'utf8',
    );
    const literal = /v_old jsonb := '([^']+)'::jsonb;/.exec(migration)?.[1];
    expect(literal).toBeDefined();
    // The seed built every invoice route from one shape; the credit note still uses it.
    const before = JSON.stringify(WorkflowSpecSchema.parse(CREDIT_NOTE_WORKFLOW_SPEC))
      .replace('"credit_note"', '"tax_invoice"')
      .replace('checks the credit note', 'checks the tax invoice');
    expect(JSON.parse(literal ?? 'null')).toEqual(JSON.parse(before));
  });

  it.each(P3_WORKFLOWS)(
    'seeds the %s workflow for the entity as published v1',
    async (documentType, name) => {
      const { client, calls } = fakeClient(firstRun);
      await seedKernelRows(client, scope);

      const definition = calls.find(
        (c) => c.text.includes('INTO app.workflow_definitions') && c.values[2] === documentType,
      );
      expect(definition?.values).toEqual(['tenant-1', 'org-1', documentType, name, documentType]);
      expect(definition?.text).toContain(
        'ON CONFLICT (tenant_id, organization_id, key) DO NOTHING',
      );
      const version = calls.find((c) => {
        if (!c.text.includes('INTO app.workflow_versions')) return false;
        return (
          (JSON.parse(String(c.values[3])) as { documentType: string }).documentType ===
          documentType
        );
      });
      expect(version?.text).toContain("1, 'published', $4::jsonb, now(), NULL");
      expect(version?.text).toContain('ON CONFLICT (tenant_id, definition_id, version) DO NOTHING');
    },
  );

  it('writes the invoice, payment and portal grants of the plan to role_permissions', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);

    const written = new Set(
      calls
        .filter((c) => c.text.includes('INTO app.role_permissions'))
        .map((c) => `${String(c.values[1])}|${String(c.values[2])}|${String(c.values[3])}`),
    );
    expect(written.has('finance|invoice.issue|all')).toBe(true);
    expect(written.has('finance|payment.verify|all')).toBe(true);
    expect(written.has('finance|invoice.credit_note|all')).toBe(true);
    expect(written.has('accountant|invoice.draft|all')).toBe(true);
    expect(written.has('accountant|payment.record|all')).toBe(true);
    expect(written.has('customer_user|portal.invoice.read|customer_org')).toBe(true);
    expect(written.has('customer_user|portal.payment.submit|customer_org')).toBe(true);
    expect(written.has('founder|invoice.issue|all')).toBe(true);
    // The maker never holds the checker's power.
    expect(written.has('accountant|payment.verify|all')).toBe(false);
    expect(written.has('accountant|invoice.issue|all')).toBe(false);
    expect(written.has('sales|invoice.read|own')).toBe(false);
  });

  it('is idempotent: a second run over the same keys inserts nothing and rewrites no version', async () => {
    const keys = new Set<string>();
    const keyOf = ({ text, values }: Call): string | undefined => {
      if (text.includes('INTO app.workflow_definitions')) return `def|${String(values[2])}`;
      if (text.includes('INTO app.workflow_versions')) return `ver|${String(values[2])}`;
      return undefined;
    };
    const stateful: Script = (call) => {
      if (call.text.startsWith('SELECT id FROM app.workflow_definitions')) {
        return { rows: [{ id: 'def-1' }] };
      }
      const key = keyOf(call);
      if (key === undefined) return nothingChanged(call);
      if (keys.has(key)) return { rowCount: 0 };
      keys.add(key);
      return call.text.includes('INTO app.workflow_versions')
        ? { rowCount: 1, rows: [{ id: 'ver-1' }] }
        : { rowCount: 1 };
    };
    await seedKernelRows(fakeClient(stateful).client, scope);
    for (const [documentType] of P3_WORKFLOWS) expect(keys.has(`def|${documentType}`)).toBe(true);

    const second = fakeClient(stateful);
    expect(await seedKernelRows(second.client, scope)).toBe(0);
    for (const c of second.calls.filter((q) => q.text.includes('INTO app.workflow_'))) {
      expect(c.text).not.toContain('DO UPDATE');
    }
  });
});

describe('cost centre dev seed', () => {
  it('seeds GENERAL, OPERATIONS and ADMIN in the acting entity without changing existing rows', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const centers = calls.filter((c) => c.text.includes('INSERT INTO app.cost_centers'));
    expect(centers.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', 'GENERAL', 'General'],
      ['tenant-1', 'org-1', 'OPERATIONS', 'Operations'],
      ['tenant-1', 'org-1', 'ADMIN', 'Administration'],
    ]);
    expect(
      centers.every((c) => c.text.includes('ON CONFLICT') && c.text.includes('DO NOTHING')),
    ).toBe(true);
  });
});

describe('company bank and expense account dev seed', () => {
  it('lists two active bank accounts and one retired, with only the last four of each number', () => {
    expect(
      DEV_BANK_ACCOUNTS.map((b) => [b.name, b.bankName, b.last4, b.currency, b.status]),
    ).toEqual([
      ['Operating account', 'Nabil Bank', '4821', 'NPR', 'active'],
      ['Dollar account', 'Standard Chartered Bank Nepal', '7305', 'USD', 'active'],
      ['Old payroll account', 'Global IME Bank', '1190', 'NPR', 'retired'],
    ]);
    for (const bank of DEV_BANK_ACCOUNTS) expect(bank.last4).toMatch(/^[A-Za-z0-9]{4}$/);
  });

  it('lists six active expense accounts and one retired', () => {
    expect(DEV_EXPENSE_ACCOUNTS.map((a) => [a.code, a.name, a.status])).toEqual([
      ['5100', 'Office supplies', 'active'],
      ['5200', 'Rent', 'active'],
      ['5300', 'Utilities', 'active'],
      ['5400', 'Travel', 'active'],
      ['5500', 'Professional fees', 'active'],
      ['5900', 'Other expenses', 'active'],
      ['5800', 'Closed project costs', 'retired'],
    ]);
  });

  it('inserts each bank account in the acting entity only when the entity has none of that name, of any status', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const banks = calls.filter((c) => c.text.includes('INSERT INTO app.company_bank_accounts'));
    expect(banks.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', 'Operating account', 'Nabil Bank', '4821', 'NPR', 'active'],
      [
        'tenant-1',
        'org-1',
        'Dollar account',
        'Standard Chartered Bank Nepal',
        '7305',
        'USD',
        'active',
      ],
      ['tenant-1', 'org-1', 'Old payroll account', 'Global IME Bank', '1190', 'NPR', 'retired'],
    ]);
    for (const c of banks) {
      expect(c.text).toContain('WHERE NOT EXISTS');
      expect(c.text).toContain('lower(btrim(name)) = lower(btrim($3::text))');
      // A status filter would re-insert the retired row on every run.
      expect(c.text.split('WHERE NOT EXISTS')[1]).not.toContain('status');
      expect(c.text).toContain("CASE WHEN $7::text = 'retired' THEN now() END");
    }
  });

  it('inserts each expense account conflict-safe on the entity and lower(code), retired_at only when retired', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const accounts = calls.filter((c) => c.text.includes('INSERT INTO app.expense_accounts'));
    expect(accounts.map((c) => c.values)).toEqual([
      ['tenant-1', 'org-1', '5100', 'Office supplies', 'active'],
      ['tenant-1', 'org-1', '5200', 'Rent', 'active'],
      ['tenant-1', 'org-1', '5300', 'Utilities', 'active'],
      ['tenant-1', 'org-1', '5400', 'Travel', 'active'],
      ['tenant-1', 'org-1', '5500', 'Professional fees', 'active'],
      ['tenant-1', 'org-1', '5900', 'Other expenses', 'active'],
      ['tenant-1', 'org-1', '5800', 'Closed project costs', 'retired'],
    ]);
    for (const c of accounts) {
      expect(c.text).toContain('ON CONFLICT (tenant_id, organization_id, lower(code)) DO NOTHING');
      expect(c.text).toContain("CASE WHEN $5::text = 'retired' THEN now() END");
    }
  });

  it('never updates or deletes an account row: the guards freeze them and a hand edit is kept', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const touching = calls.filter((c) =>
      /app\.(company_bank_accounts|expense_accounts)/.test(c.text),
    );
    expect(touching).toHaveLength(DEV_BANK_ACCOUNTS.length + DEV_EXPENSE_ACCOUNTS.length);
    for (const c of touching) {
      expect(c.text.startsWith('INSERT')).toBe(true);
      expect(c.text).not.toContain('DO UPDATE');
    }
  });

  it('writes after the seed actor, inside the one transaction', async () => {
    const { client, calls } = fakeClient(firstRun);
    await seedKernelRows(client, scope);
    const actor = calls.findIndex((c) => c.text.includes("set_config('bos.actor_kind'"));
    const first = calls.findIndex((c) => c.text.includes('INTO app.company_bank_accounts'));
    expect(actor).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(actor);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('counts every account on a first run and changes nothing on a second over the same keys', async () => {
    const keys = new Set<string>();
    // Bank accounts are keyed by entity and name, expense accounts by entity and lower(code), like the SQL.
    const keyOf = ({ text, values }: Call): string | undefined => {
      if (text.includes('INTO app.company_bank_accounts')) {
        return `bank|${String(values[1])}|${String(values[2]).trim().toLowerCase()}`;
      }
      if (text.includes('INTO app.expense_accounts')) {
        return `expense|${String(values[1])}|${String(values[2]).toLowerCase()}`;
      }
      return undefined;
    };
    const stateful: Script = (call) => {
      const key = keyOf(call);
      if (key === undefined) return nothingChanged(call);
      if (keys.has(key)) return { rowCount: 0 };
      keys.add(key);
      return { rowCount: 1 };
    };
    expect(await seedKernelRows(fakeClient(stateful).client, scope)).toBe(
      DEV_BANK_ACCOUNTS.length + DEV_EXPENSE_ACCOUNTS.length,
    );
    expect([...keys].filter((k) => k.startsWith('bank|'))).toHaveLength(3);
    expect([...keys].filter((k) => k.startsWith('expense|'))).toHaveLength(7);

    expect(await seedKernelRows(fakeClient(stateful).client, scope)).toBe(0);
  });
});
