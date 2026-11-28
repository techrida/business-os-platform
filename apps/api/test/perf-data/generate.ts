import 'reflect-metadata';
import { Readable } from 'node:stream';
import type { RoleKey } from '@bos/contracts';
import type { DbHandle } from '@bos/db';
import type { Db } from '../../src/platform/db/db.module';
import type { Queue } from 'bullmq';
import { AuditService } from '../../src/platform/audit/audit.service';
import { AuthzService } from '../../src/platform/authz/authz.service';
import { RoleCache } from '../../src/platform/authz/role-cache';
import { type Principal } from '../../src/platform/authz/principal';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../src/platform/tenancy/request-context';
import { requestTx, withTx } from '../../src/platform/db/tx';
import { ClamdClient } from '../../src/platform/documents/clamd.client';
import { DocumentsService } from '../../src/platform/documents/documents.service';
import { ScanProcessor } from '../../src/platform/documents/scan.processor';
import { SignedLinks } from '../../src/platform/documents/signed-link';
import { DiskStorageAdapter } from '../../src/platform/documents/storage.adapter';
import { CurrencyEnabledService } from '../../src/platform/settings/currency-enabled';
import { MoneyService } from '../../src/platform/settings/money.service';
import { NumberingService } from '../../src/platform/settings/numbering.service';
import { SettingsService } from '../../src/platform/settings/settings.service';
import { SqlUsersStore } from '../../src/platform/users/users.store';
import { ApprovalsCaller } from '../../src/modules/approvals/ports';
import { ApprovalsService } from '../../src/modules/approvals/requests.service';
import {
  InvoiceApprovalService,
  InvoiceApprovalSubject,
} from '../../src/modules/invoices/invoice-approval.service';
import { InvoiceDraftingService } from '../../src/modules/invoices/invoice-drafting.service';
import { InvoiceIssueService } from '../../src/modules/invoices/invoice-issue.service';
import { InvoiceCaller } from '../../src/modules/invoices/invoice-support';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { VendorBillsCaller } from '../../src/modules/payables/bills/vendor-bills.caller';
import { VendorBillsService } from '../../src/modules/payables/bills/vendor-bills.service';
import { billDocumentOwnerPolicy } from '../../src/modules/payables/bills/bill-documents.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import {
  PaymentIntakeOwnerPolicy,
  drizzleCustomerPartyLoader,
  PAYMENT_INTAKE_OWNER_TYPE,
} from '../../src/modules/payments/payment-owner.policy';
import { TestMemoCaller } from '../../src/modules/test-memo/test-memo.caller';
import { TestMemoService } from '../../src/modules/test-memo/test-memo.service';
import {
  assertCompany,
  createCompany,
  crm,
  customer,
  department,
  ensureStorageRoot,
  expense,
  perfId,
  PerfDataError,
  scope,
  staff,
  staffOrg,
  transaction,
  vat,
  vendor,
  type Pool,
} from './company';

export interface Sizes {
  waitingPerApprover: number;
  leads: number;
  activities: number;
  customers: number;
  invoicesPerCustomer: number;
  payments: number;
  bills: number;
  auditEvents: number;
}
export const fullSizes: Sizes = {
  waitingPerApprover: 2500,
  leads: 5000,
  activities: 20000,
  customers: 50,
  invoicesPerCustomer: 200,
  payments: 5000,
  bills: 5000,
  auditEvents: 100000,
};

type StaffRole = keyof typeof staff;
type Head = { id: string; status: string; version: number };

/** Internal offline fixture runner; never a server route or a sign-in shortcut. */
export async function generate(
  handle: DbHandle,
  sizes: Sizes,
  storageRoot: string,
  clamd: ClamdClient,
) {
  for (const value of Object.values(sizes))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new PerfDataError('Counts must be non-negative integers');
  if (sizes.customers < 1 || sizes.leads < 1)
    throw new PerfDataError('At least one customer and lead required');
  const { pool } = handle;
  // The API uses the same Drizzle driver without its relational schema generic. These services use only SQL/table queries.
  const db = handle.db as unknown as Db;
  await ensureStorageRoot(pool, storageRoot);
  await createCompany(pool, sizes.customers);
  await crm(pool, sizes.leads, sizes.activities);
  const audit = new AuditService(db),
    cache = new RoleCache(db),
    authz = new AuthzService(db, cache),
    settings = new SettingsService(db),
    money = new MoneyService(db, settings),
    numbering = new NumberingService(),
    ledger = new LedgerService();
  const storage = new DiskStorageAdapter(storageRoot);
  // No consumer or email delivery is started by the offline data tool. Real audit and business writes run unchanged.
  const notify = { notifyUser: async () => {}, notifyRole: async () => {} };
  const docs = new DocumentsService(
    db,
    storage,
    new SignedLinks(undefined, { claim: () => Promise.resolve(false) }),
    { add: () => Promise.resolve({}) } as unknown as Queue,
    authz,
    audit,
  );
  const scan = new ScanProcessor(db, storage, clamd, audit, notify);
  docs.registerOwner(new PaymentIntakeOwnerPolicy(drizzleCustomerPartyLoader(db)));
  docs.registerOwner(billDocumentOwnerPolicy(db));
  const { rows: anchors } = await pool.query<{ created_at: Date }>(
    'SELECT created_at FROM app.organizations WHERE id=$1 AND tenant_id=$2',
    [scope.organizationId, scope.tenantId],
  );
  const anchor = anchors[0]!.created_at;
  let now = anchor;
  const clock = () => now;
  const approvals = new ApprovalsService(
    db,
    audit,
    notify,
    new SqlUsersStore(db) as unknown as ConstructorParameters<typeof ApprovalsService>[3],
    new ApprovalsCaller(),
    clock,
  );
  approvals.registerSubject(new InvoiceApprovalSubject('tax_invoice', clock));
  const invoiceCaller = new InvoiceCaller();
  const drafting = new InvoiceDraftingService(
    db,
    authz,
    audit,
    invoiceCaller,
    ledger,
    new CurrencyEnabledService(settings),
    clock,
  );
  const submitting = new InvoiceApprovalService(
    db,
    authz,
    audit,
    invoiceCaller,
    approvals,
    notify,
    money,
    drafting,
    clock,
  );
  const issuing = new InvoiceIssueService(
    db,
    authz,
    audit,
    invoiceCaller,
    ledger,
    numbering,
    money,
    settings,
    clock,
  );
  const memos = new TestMemoService(
    db,
    numbering,
    money,
    docs,
    approvals,
    authz,
    cache,
    new TestMemoCaller(),
    clock,
    settings,
  );
  memos.onModuleInit();
  const payments = new PaymentsService(db, authz, money, numbering, audit, ledger, clock);
  const bills = new VendorBillsService(
    db,
    approvals,
    audit,
    settings,
    new VendorBillsCaller(),
    clock,
  );

  async function as<T>(role: StaffRole, key: string, fn: () => Promise<T>): Promise<T> {
    const roles: RoleKey[] = role === 'management' ? [role, 'accountant'] : [role];
    const grants = await cache.grantsFor(scope.tenantId, scope.organizationId, roles);
    const principal: Principal = {
      ...scope,
      userId: staff[role],
      zitadelUserId: `perf-db-only-${role}`,
      idpOrgId: staffOrg,
      orgKind: 'staff',
      partyId: null,
      departmentId: department,
      roles,
      status: 'active',
      grants,
    };
    return runWithRequestStore(`perf-${key}`, () => {
      bindIdentity({
        ...scope,
        userId: principal.zitadelUserId,
        idpOrgId: staffOrg,
        orgKind: 'staff',
        partyId: null,
        departmentId: department,
        roles,
        tokenExp: Math.floor(Date.now() / 1000) + 60,
      });
      bindPrincipal(principal);
      return fn();
    });
  }
  // The same configuration path as db-seed.ts: audited reference rows, not fabricated approval decisions.
  await transaction(pool, async (c) => {
    if (!(await assertCompany(c))) throw new PerfDataError('Missing perf company');
    for (const type of ['test_memo', 'tax_invoice']) {
      const def = perfId(`workflow-${type}`),
        ver = perfId(`workflow-${type}-v1`);
      const spec = {
        documentType: type,
        steps: [
          { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
          { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
        ],
        rules: [],
        distinctApprovers: true,
      };
      await c.query(
        `INSERT INTO app.workflow_definitions (id,tenant_id,organization_id,key,name,document_type) VALUES ($1,$2,$3,$4,$4,$4) ON CONFLICT DO NOTHING`,
        [def, scope.tenantId, scope.organizationId, type],
      );
      await c.query(
        `INSERT INTO app.workflow_versions (id,tenant_id,organization_id,definition_id,version,status,spec,published_at,published_by,created_by) VALUES ($1,$2,$3,$4,1,'published',$5,now(),$6,$7) ON CONFLICT DO NOTHING`,
        [
          ver,
          scope.tenantId,
          scope.organizationId,
          def,
          JSON.stringify(spec),
          staff.founder,
          staff.management,
        ],
      );
      await c.query(
        'UPDATE app.workflow_definitions SET current_version_id=$1 WHERE id=$2 AND tenant_id=$3 AND current_version_id IS NULL',
        [ver, def, scope.tenantId],
      );
    }
  });
  await as('founder', 'settings', async () => {
    const { actor } = requestTx();
    for (const [key, value] of [
      ['entity.pan_vat_no', '123456789'],
      ['entity.address', { line: 'Test address', city: 'Kathmandu', country: 'NP' }],
    ] as const) {
      if ((await settings.get(scope, key)) === null)
        await withTx(db, scope, actor, (tx) => settings.set(tx, key, value));
    }
  });

  async function head(
    table: 'test_memos' | 'invoices' | 'payments' | 'vendor_bills',
    field: 'title' | 'manual_reason' | 'bank_reference' | 'vendor_invoice_no',
    value: string,
  ) {
    return (
      await pool.query<Head>(
        `SELECT id,status,version FROM app.${table} WHERE tenant_id=$1 AND organization_id=$2 AND ${field}=$3`,
        [scope.tenantId, scope.organizationId, value],
      )
    ).rows[0];
  }
  async function approve(documentId: string, role: StaffRole, key: string) {
    const r = (
      await pool.query<{ id: string; version: number; current_seq: number; status: string }>(
        `SELECT id,version,current_seq,status FROM app.approval_requests WHERE tenant_id=$1 AND organization_id=$2 AND document_id=$3 ORDER BY submitted_at DESC LIMIT 1`,
        [scope.tenantId, scope.organizationId, documentId],
      )
    ).rows[0]!;
    if (r.status !== 'pending') return;
    await as(role, key, () =>
      approvals.act(r.id, { action: 'approve', expectedVersion: r.version }, perfId(key)),
    );
  }
  // Two real template-memo routes: the first approver has their step active; the final approver has a real recommendation.
  for (let n = 0; n < sizes.waitingPerApprover * 3; n++) {
    const title = `Perf memo ${n + 1}`;
    let h = await head('test_memos', 'title', title);
    if (!h) {
      const m = await as('sales', `memo-${n}`, () =>
        memos.create({
          title,
          body: 'Synthetic performance memo',
          template: {
            departmentId: department,
            date: anchor.toISOString().slice(0, 10),
            closing: '',
            preparedByUserId: staff.sales,
            recommenderUserIds: [staff.accountant, staff.finance],
            approvedByUserId: staff.founder,
          },
        }),
      );
      h = { id: m.id, status: m.status, version: m.version };
    }
    if (h.status === 'draft')
      await as('sales', `memo-submit-${n}`, () => memos.submit(h.id, h.version));
    if (n >= sizes.waitingPerApprover) {
      const step = await pool.query(
        `SELECT 1 FROM app.approval_requests r JOIN app.approval_steps s ON s.request_id=r.id AND s.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.document_id=$2 AND s.seq=1 AND s.status='active'`,
        [scope.tenantId, h.id],
      );
      if (step.rowCount) await approve(h.id, 'accountant', `memo-recommend-${n}`);
      if (n >= sizes.waitingPerApprover * 2) {
        const next = await pool.query(
          `SELECT 1 FROM app.approval_requests r JOIN app.approval_steps s ON s.request_id=r.id AND s.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.document_id=$2 AND s.seq=2 AND s.status='active'`,
          [scope.tenantId, h.id],
        );
        if (next.rowCount) await approve(h.id, 'finance', `memo-recommend-finance-${n}`);
      }
    }
  }
  const total = sizes.customers * sizes.invoicesPerCustomer;
  for (let n = 0; n < total; n++) {
    // Stable date spread, from oldest to newest; the company creation time is the resume anchor.
    now = new Date(anchor.getTime() - (365 - Math.floor(((n + 1) * 365) / total)) * 86400000);
    const key = `invoice-${n}`,
      reason = `Perf manual sale ${n + 1}`;
    let h = await head('invoices', 'manual_reason', reason);
    if (!h) {
      const { invoice } = await as('accountant', key, () =>
        drafting.draftManual(
          {
            customerId: customer(n % sizes.customers),
            currency: 'NPR',
            manualReason: reason,
            lines: [
              {
                description: 'Synthetic test service',
                uom: 'lot',
                quantity: '1',
                unitPrice: '1000.00',
                taxCodeId: vat,
              },
            ],
          },
          perfId(key),
        ),
      );
      h = { id: invoice.id, version: invoice.version, status: invoice.status };
    }
    if (h.status === 'draft')
      await as('accountant', `${key}-submit`, () =>
        submitting.submit(h.id, { expectedVersion: h.version }, perfId(`${key}-submit`)),
      );
    // The requester cannot approve: use the second accountant role holder (management also carries accountant below).
    if (h.status !== 'issued') {
      const request = (
        await pool.query<{ current_seq: number; status: string }>(
          'SELECT current_seq,status FROM app.approval_requests WHERE tenant_id=$1 AND document_id=$2',
          [scope.tenantId, h.id],
        )
      ).rows[0]!;
      if (request.status === 'pending' && request.current_seq === 1)
        await approve(h.id, 'management', `${key}-check`);
      const refreshed = await head('invoices', 'manual_reason', reason);
      if (refreshed?.status === 'submitted') await approve(h.id, 'finance', `${key}-approve`);
      const final = await head('invoices', 'manual_reason', reason);
      if (final?.status === 'approved')
        await as('finance', `${key}-issue`, () =>
          issuing.issue(final.id, { expectedVersion: final.version }, perfId(`${key}-issue`)),
        );
    }
  }
  now = anchor;
  async function proof(role: StaffRole, ownerType: string, ownerId: string, key: string) {
    const filename = `perf-${key}.pdf`;
    // Real bytes via the upload/scan pipeline, not a manufactured clean document row.
    const file = fixturePdf(key);
    let row = (
      await pool.query<{ document_id: string; id: string; status: string }>(
        `SELECT document_id,id,status FROM app.document_versions WHERE tenant_id=$1 AND organization_id=$2 AND filename=$3`,
        [scope.tenantId, scope.organizationId, filename],
      )
    ).rows[0];
    if (!row) {
      const created = await as(role, `${key}-proof`, () =>
        withTx(db, scope, requestTx().actor, (tx) =>
          docs.create(tx, {
            ownerType,
            ownerId,
            filename,
            declaredMime: 'application/pdf',
            sizeBytes: file.length,
          }),
        ),
      );
      row = { document_id: created.documentId, id: created.versionId, status: 'awaiting_content' };
    }
    if (row.status === 'awaiting_content')
      await as(role, `${key}-upload`, () =>
        docs.receiveContent(row.id, Readable.from(file), file.length, {
          documentId: row.document_id,
        }),
      );
    if (row.status !== 'clean') {
      await scan.scanVersion({ ...scope, versionId: row.id }, false);
      const state = await pool.query<{ status: string }>(
        'SELECT status FROM app.document_versions WHERE tenant_id=$1 AND id=$2',
        [scope.tenantId, row.id],
      );
      if (state.rows[0]?.status !== 'clean')
        throw new PerfDataError('Perf proof did not scan clean; check the local scanner and retry');
    }
    return row.document_id;
  }
  for (let n = 0; n < sizes.payments; n++) {
    const key = `payment-${n}`,
      reference = `PERF-PAY-${n + 1}`;
    if (await head('payments', 'bank_reference', reference)) continue;
    const party = customer(n % sizes.customers),
      doc = await proof('accountant', PAYMENT_INTAKE_OWNER_TYPE, party, key);
    await as('accountant', key, () =>
      payments.submit(
        scope,
        requestTx().actor,
        {
          customerId: party,
          method: 'bank_transfer',
          currency: 'NPR',
          amount: '500.00',
          tdsWithheld: '0.00',
          receivedOn: anchor.toISOString().slice(0, 10),
          bankReference: reference,
          proofDocumentIds: [doc],
        },
        'staff',
        perfId(key),
      ),
    );
  }
  for (let n = 0; n < sizes.bills; n++) {
    const key = `bill-${n}`,
      number = `PERF-BILL-${n + 1}`;
    if (await head('vendor_bills', 'vendor_invoice_no', number)) continue;
    const doc = await proof('accountant', 'vendor_bill_intake', vendor, key);
    await as('accountant', key, () =>
      bills.create(
        {
          vendorPartyId: vendor,
          kind: 'bill',
          vendorInvoiceNo: number,
          invoiceDate: anchor.toISOString().slice(0, 10),
          currency: 'NPR',
          documentId: doc,
          lines: [{ accountId: expense, quantity: '1', unitPrice: '1000.00', taxCodeId: vat }],
        },
        perfId(key),
      ),
    );
  }
  // Audit rows from all normal writes count toward the target; top up with explicitly labelled seed events, never invented financial decisions.
  await transaction(pool, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      'SELECT count(*)::int n FROM audit.audit_events WHERE tenant_id=$1',
      [scope.tenantId],
    );
    const missing = Math.max(0, sizes.auditEvents - rows[0]!.n);
    if (missing)
      await c.query(
        `SELECT audit.record('perf.seed.sample','perf_fixture',$1||':'||n,NULL,jsonb_build_object('sample',n),NULL) FROM generate_series(1,$2::int) n`,
        [String(rows[0]!.n), missing],
      );
  });
  return manifest(pool);
}

export async function manifest(pool: Pool) {
  const tables = [
    'test_memos',
    'approval_requests',
    'leads',
    'activities',
    'invoices',
    'payments',
    'vendor_bills',
  ] as const;
  const ids = Object.fromEntries(
    await Promise.all(
      tables.map(
        async (table) =>
          [
            table,
            (
              await pool.query<{ id: string }>(
                `SELECT id FROM app.${table} WHERE tenant_id=$1 AND organization_id=$2 ORDER BY id`,
                [scope.tenantId, scope.organizationId],
              )
            ).rows.map((r) => r.id),
          ] as const,
      ),
    ),
  ) as Record<(typeof tables)[number], string[]>;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id::text FROM audit.audit_events WHERE tenant_id=$1 ORDER BY id',
    [scope.tenantId],
  );
  return {
    ...scope,
    staff,
    staffIdpOrgId: staffOrg,
    approverGroups: Object.fromEntries(
      ['accountant', 'finance', 'founder'].map((role) => [role, perfId(`group-${role}`)]),
    ),
    customerIds: (
      await pool.query<{ id: string }>(
        `SELECT id FROM app.customers WHERE tenant_id=$1 ORDER BY id`,
        [scope.tenantId],
      )
    ).rows.map((r) => r.id),
    portalUsers: (
      await pool.query<{ id: string; party_id: string; idp_org_id: string }>(
        `SELECT u.id,o.party_id,u.idp_org_id FROM app.users u JOIN app.idp_orgs o ON o.id=u.idp_org_id AND o.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND o.kind='customer' ORDER BY u.id`,
        [scope.tenantId],
      )
    ).rows,
    ids: { ...ids, audit_events: rows.map((r) => r.id) },
  };
}

// A real, small, readable PDF with an explicit synthetic-fixture label, not a false financial record.
function fixturePdf(key: string): Buffer {
  const stream = `BT /F1 12 Tf 40 750 Td (Synthetic perf fixture: ${key}) Tj 0 -20 Td (Not a financial document) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, n) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${n + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
