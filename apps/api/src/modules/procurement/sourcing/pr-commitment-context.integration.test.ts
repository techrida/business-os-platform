// The commitment approval context lists the recommended quotation's evidence file (round 5 P5 item 6), on a real
// Postgres. Real: migrations, queries as bos_app, the evidence upload through EvidenceDocumentsService and
// DocumentsService (evidence.fixture.ts), PrCommitmentSubject.context with readableDocuments, and
// DocumentsService.issueLink (the signed-file route's service) as the approver. The scan is the only shortcut: the
// uploaded version is marked clean as the scan worker would. Request, RFQ and quotation rows are inserted directly.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/pr-commitment-context.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { HttpException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import {
  EVIDENCE_PDF,
  evidenceFixture,
  type EvidenceFixture,
} from '../../evidence/evidence.fixture';
import { VENDOR_INTAKE_OWNER_TYPE } from '../../portal-vendor/inbox/vendor-intake.policy';
import { PrCommitmentSubject } from './pr-commitment.subject';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let otherTenant: TxScope;
let evidence: EvidenceFixture;
let subject: PrCommitmentSubject;
let deptA = '';
const U = { req: '', proc: '', mgmt: '' };

const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'procurement',
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
  U.req = await staff('operations_officer');
  U.proc = await staff('procurement');
  U.mgmt = await staff('management');
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  subject = new PrCommitmentSubject(new NumberingService());
  evidence = await evidenceFixture(db, caller.current);
});

afterAll(async () => {
  await evidence?.close();
  await appPool?.end();
  await testDb?.drop();
});

beforeEach(() => as(U.proc, 'procurement'));

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
                ${String(320_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${partyId}, true)`,
  );
  return partyId;
}

/** An open RFQ created by procurement, on an approved request of the requester. */
async function openRfq(): Promise<{ id: string; prId: string }> {
  const prId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = '1130.00',
          estimated_total_npr = '1130.00', number = ${`PR-C-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.rfqs (tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${prId}, ${`RFQ-${prId.slice(0, 8)}`},
                '2026-12-15T00:00:00Z', ${U.proc}) RETURNING id`,
  );
  return { id: idOf(rows), prId };
}

/** Evidence uploaded to the RFQ by its creator through the real routes' service, then scanned clean. */
async function cleanEvidence(rfqId: string): Promise<string> {
  as(U.proc, 'procurement');
  const documentId = await evidence.upload('rfq', rfqId);
  await exec(
    scopeA,
    sql`UPDATE app.document_versions SET status = 'clean', scanned_at = now()
        WHERE document_id = ${documentId}`,
  );
  return documentId;
}

/** A clean quotation file the vendor sent from the portal. */
async function portalFile(vendorId: string): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${VENDOR_INTAKE_OWNER_TYPE}, ${vendorId})
        RETURNING id`,
  );
  const documentId = idOf(rows);
  await exec(
    scopeA,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'quotation.pdf',
                'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
  );
  return documentId;
}

/** A quotation on the RFQ with this file, made the RFQ's recommended one. */
async function recommend(
  rfq: { id: string; prId: string },
  vendorId: string,
  documentId: string,
): Promise<void> {
  await exec(
    scopeA,
    sql`INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${rfq.id}, ${vendorId}, ${U.proc})`,
  );
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.vendor_quotations (tenant_id, organization_id, rfq_id, purchase_request_id, vendor_id,
          currency, subtotal, tax_amount, total, fx_rate, total_npr, document_id, recorded_by)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${rfq.id}, ${rfq.prId}, ${vendorId}, 'NPR',
                '1000.00', '130.00', '1130.00', 1, '1130.00', ${documentId}, ${U.proc}) RETURNING id`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.rfqs SET recommended_quotation_id = ${idOf(rows)} WHERE id = ${rfq.id}`,
  );
}

const contextAs = (rfqId: string, scope: TxScope = scopeA) =>
  subject.context(db, scope, { documentId: rfqId }, principalNow());
const ids = (docs: readonly { documentId: string }[] | undefined) =>
  (docs ?? []).map((d) => d.documentId);

describe('commitment approval context: the recommended quotation evidence', () => {
  it('lists the evidence for the approver, who can open it through the link route', async () => {
    const rfq = await openRfq();
    const evidenceId = await cleanEvidence(rfq.id);
    await recommend(rfq, await vendor(), evidenceId);

    as(U.mgmt, 'management');
    const context = await contextAs(rfq.id);
    expect(ids(context?.documents)).toEqual([evidenceId]);
    expect(context?.documents[0]).toMatchObject({
      filename: 'evidence.pdf',
      detectedMime: 'application/pdf',
      sizeBytes: EVIDENCE_PDF.length,
      uploadedBy: U.proc,
      uploadedAt: expect.any(String) as unknown,
    });
    const link = await evidence.documents.issueLink(
      scopeA,
      context!.documents[0]!.versionId,
      evidenceId,
    );
    expect(link.url).toBeTruthy();
  });

  it('lists it for the preparer too', async () => {
    const rfq = await openRfq();
    const evidenceId = await cleanEvidence(rfq.id);
    await recommend(rfq, await vendor(), evidenceId);
    expect(ids((await contextAs(rfq.id))?.documents)).toEqual([evidenceId]);
  });

  it('still lists a file the vendor sent from the portal', async () => {
    const rfq = await openRfq();
    const vendorId = await vendor();
    const sent = await portalFile(vendorId);
    await recommend(rfq, vendorId, sent);
    as(U.mgmt, 'management');
    const context = await contextAs(rfq.id);
    expect(ids(context?.documents)).toEqual([sent]);
    expect(context?.documents[0]?.filename).toBe('quotation.pdf');
  });

  it('leaves out evidence uploaded to another RFQ, even when the quotation row names it', async () => {
    const rfq = await openRfq();
    const other = await openRfq();
    const foreign = await cleanEvidence(other.id);
    await recommend(rfq, await vendor(), foreign);
    as(U.mgmt, 'management');
    expect(ids((await contextAs(rfq.id))?.documents)).toEqual([]);
  });

  it('leaves it out for a reader the document read rule excludes, whom the link route refuses too', async () => {
    const rfq = await openRfq();
    const evidenceId = await cleanEvidence(rfq.id);
    await recommend(rfq, await vendor(), evidenceId);
    // The requester holds documents.read on their own records only, and did not create this RFQ.
    as(U.req, 'operations_officer');
    expect(ids((await contextAs(rfq.id))?.documents)).toEqual([]);

    const { rows } = await exec(
      scopeA,
      sql`SELECT id FROM app.document_versions WHERE document_id = ${evidenceId}`,
    );
    const refused = await evidence.documents
      .issueLink(scopeA, idOf(rows), evidenceId)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(403);
  });

  it('shows nothing from another entity or another tenant', async () => {
    const rfq = await openRfq();
    const evidenceId = await cleanEvidence(rfq.id);
    await recommend(rfq, await vendor(), evidenceId);
    as(U.mgmt, 'management', scopeB);
    expect(await contextAs(rfq.id, scopeB)).toBeNull();
    as(U.mgmt, 'management', otherTenant);
    expect(await contextAs(rfq.id, otherTenant)).toBeNull();
  });
});
