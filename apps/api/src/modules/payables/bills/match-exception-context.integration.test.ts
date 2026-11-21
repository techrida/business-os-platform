// The match exception's approval context lists the exception's evidence (round 5 P5 item 6), on a real Postgres.
// Real: migrations, queries as bos_app, the evidence upload through EvidenceDocumentsService and DocumentsService
// (evidence.fixture.ts), MatchExceptionSubject.context with readableDocuments, and DocumentsService.issueLink (the
// signed-file route's service) as the approver. The scan is the only shortcut: the uploaded version is marked clean
// as the scan worker would. Rows the API has no route for here (bill, exception) are inserted directly.
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/match-exception-context.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { HttpException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import {
  EVIDENCE_PDF,
  evidenceFixture,
  type EvidenceFixture,
} from '../../evidence/evidence.fixture';
import { MatchExceptionSubject } from './vendor-bill.subject';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let otherTenant: TxScope;
let evidence: EvidenceFixture;
let subject: MatchExceptionSubject;
const U = { acct: '', fin: '', proc: '', mgmt: '' };

const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'accountant',
  scope: null,
};
const as = (userId: string, role: RoleKey, scope: TxScope | null = null) => {
  current.userId = userId;
  current.role = role;
  current.scope = scope;
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...(current.scope ?? scopeA),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [current.role],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[current.role])) as Map<Permission, Scope>,
});
const caller = {
  current: () => ({
    scope: current.scope ?? scopeA,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));
const idOf = (rows: unknown[]) => (rows[0] as { id: string }).id;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
        VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  const tenant2 = await createTenantWithEntity(appPool);
  otherTenant = { tenantId: tenant2.tenantId, organizationId: tenant2.organizationId };

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.acct = await staff('accountant');
  U.fin = await staff('finance');
  U.proc = await staff('procurement');
  U.mgmt = await staff('management');

  subject = new MatchExceptionSubject(new AuditService(db));
  evidence = await evidenceFixture(db, caller.current);
});

afterAll(async () => {
  await evidence?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => as(U.acct, 'accountant'));

let panSeq = 0;
async function vendor(): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(310_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${partyId}, true)`,
  );
  return partyId;
}

/** A draft bill entered by the accountant, with its clean invoice file sent by the vendor. */
async function draftBill(): Promise<{ id: string; documentId: string }> {
  const vendorId = await vendor();
  const { rows: d } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_bill_intake', ${vendorId}) RETURNING id`,
  );
  const documentId = idOf(d);
  await exec(
    scopeA,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'invoice.pdf',
                'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
  );
  const { rows: b } = await exec(
    scopeA,
    sql`INSERT INTO app.vendor_bills (tenant_id, organization_id, vendor_id, vendor_invoice_no, invoice_date,
          fiscal_year, currency, document_id, fx_rate, payable_total_npr, entered_by)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${vendorId}, ${`INV-${randomUUID().slice(0, 8)}`},
                '2026-11-09', '2083/84', 'NPR', ${documentId}, 1, 0, ${U.acct}) RETURNING id`,
  );
  return { id: idOf(b), documentId };
}

/** Evidence uploaded to the bill by its enterer through the real routes' service, then scanned clean. */
async function cleanEvidence(billId: string): Promise<string> {
  as(U.acct, 'accountant');
  const documentId = await evidence.upload('vendor_bill', billId);
  await exec(
    scopeA,
    sql`UPDATE app.document_versions SET status = 'clean', scanned_at = now()
        WHERE document_id = ${documentId}`,
  );
  return documentId;
}

/** A pending match exception on the bill, naming this evidence file. */
async function exception(billId: string, evidenceDocumentId: string | null): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.match_exceptions (tenant_id, organization_id, vendor_bill_id, reason, evidence_document_id,
          requested_by)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${billId}, 'Vendor raised the price',
                ${evidenceDocumentId}, ${U.acct}) RETURNING id`,
  );
  return idOf(rows);
}

const contextAs = (exceptionId: string, scope: TxScope = scopeA) =>
  subject.context(db, scope, { documentId: exceptionId }, principalNow());
const ids = (docs: readonly { documentId: string }[] | undefined) =>
  (docs ?? []).map((d) => d.documentId);

describe('match exception approval context: the exception evidence', () => {
  it('lists the evidence after the bill file for the approver, who can open it through the link route', async () => {
    const bill = await draftBill();
    const evidenceId = await cleanEvidence(bill.id);
    const exceptionId = await exception(bill.id, evidenceId);

    as(U.fin, 'finance');
    const context = await contextAs(exceptionId);
    expect(ids(context?.documents)).toEqual([bill.documentId, evidenceId]);
    expect(context?.documents[1]).toMatchObject({
      filename: 'evidence.pdf',
      detectedMime: 'application/pdf',
      sizeBytes: EVIDENCE_PDF.length,
      uploadedBy: U.acct,
      uploadedAt: expect.any(String) as unknown,
    });

    const link = await evidence.documents.issueLink(
      scopeA,
      context!.documents[1]!.versionId,
      evidenceId,
    );
    expect(link.url).toBeTruthy();
  });

  it('lists it for the preparer too, and the bill file stays as before', async () => {
    const bill = await draftBill();
    const evidenceId = await cleanEvidence(bill.id);
    const exceptionId = await exception(bill.id, evidenceId);
    const context = await contextAs(exceptionId);
    expect(ids(context?.documents)).toEqual([bill.documentId, evidenceId]);
  });

  it('lists only the bill file when the exception has no evidence', async () => {
    const bill = await draftBill();
    const exceptionId = await exception(bill.id, null);
    as(U.fin, 'finance');
    expect(ids((await contextAs(exceptionId))?.documents)).toEqual([bill.documentId]);
  });

  it('leaves out evidence uploaded to another bill, even when the exception row names it', async () => {
    const bill = await draftBill();
    const other = await draftBill();
    const foreign = await cleanEvidence(other.id);
    const exceptionId = await exception(bill.id, foreign);
    as(U.fin, 'finance');
    expect(ids((await contextAs(exceptionId))?.documents)).toEqual([bill.documentId]);
  });

  it('leaves out evidence that is not clean yet', async () => {
    const bill = await draftBill();
    as(U.acct, 'accountant');
    const quarantined = await evidence.upload('vendor_bill', bill.id);
    const exceptionId = await exception(bill.id, quarantined);
    as(U.fin, 'finance');
    expect(ids((await contextAs(exceptionId))?.documents)).toEqual([bill.documentId]);
  });

  it('leaves it out for a reader the document read rule excludes, whom the link route refuses too', async () => {
    const bill = await draftBill();
    const evidenceId = await cleanEvidence(bill.id);
    const exceptionId = await exception(bill.id, evidenceId);
    // Procurement holds documents.read on its own records only, and did not enter this bill.
    as(U.proc, 'procurement');
    const context = await contextAs(exceptionId);
    expect(ids(context?.documents)).not.toContain(evidenceId);

    const [version] = (
      await ownerPool.query<{ id: string }>(
        `SELECT id FROM app.document_versions WHERE document_id = $1`,
        [evidenceId],
      )
    ).rows;
    const refused = await evidence.documents
      .issueLink(scopeA, version!.id, evidenceId)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(403);
  });

  it('shows nothing from another entity or another tenant', async () => {
    const bill = await draftBill();
    const evidenceId = await cleanEvidence(bill.id);
    const exceptionId = await exception(bill.id, evidenceId);
    as(U.fin, 'finance', scopeB);
    expect(await contextAs(exceptionId, scopeB)).toBeNull();
    as(U.fin, 'finance', otherTenant);
    expect(await contextAs(exceptionId, otherTenant)).toBeNull();
  });
});
