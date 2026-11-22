// A deferred scan (bytes kept, only the scan queue was down) is a 202 with the quarantined version on EVERY upload route, through
// the real HTTP layer: Nest resets a status a handler sets, so the global error filter sends it (FU11). Any other 503 stays a 503.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { DocumentVersionDto } from '@bos/contracts';
import {
  Controller,
  Post,
  Put,
  ServiceUnavailableException,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { EvidenceDocumentsController } from '../../modules/evidence/evidence-documents.controller';
import { EvidenceDocumentsService } from '../../modules/evidence/evidence-documents.service';
import { BillDocumentsController } from '../../modules/payables/bills/bill-documents.controller';
import { BillDocumentsService } from '../../modules/payables/bills/bill-documents.service';
import { PaymentProofsService } from '../../modules/payment-proofs/payment-proofs.service';
import { PortalPaymentProofsController } from '../../modules/payment-proofs/portal-payment-proofs.controller';
import { StaffPaymentProofsController } from '../../modules/payment-proofs/staff-payment-proofs.controller';
import { VendorPortalInboxController } from '../../modules/portal-vendor/inbox/portal-vendor-inbox.controller';
import { VendorPortalInboxService } from '../../modules/portal-vendor/inbox/portal-vendor-inbox.service';
import { VendorBankEvidenceController } from '../../modules/vendors/bank/bank-evidence.controller';
import { VendorBankEvidenceService } from '../../modules/vendors/bank/bank-evidence.service';
import type { Principal } from '../authz/principal';
import { DB } from '../db/db.module';
import { DocumentsController } from '../documents/documents.controller';
import { DocumentsService } from '../documents/documents.service';
import { ScanQueueDeferredError } from '../documents/scan-queue-deferred.error';
import { ErrorBodyFilter } from './error-body.filter';
import { bindIdentity, bindPrincipal, runWithRequestStore } from './request-context';

const version = {
  id: 'v1',
  status: 'quarantined',
  filename: 'proof.pdf',
} as unknown as DocumentVersionDto;

/** A 503 that is not a deferred scan, from another source (for example a downstream that is down). */
class DownstreamUnavailable extends ServiceUnavailableException {}

/** Carries a `version` like the deferred error but is not one: the filter must decide by class, not by shape. */
class VersionShapedUnavailable extends ServiceUnavailableException {
  readonly version = version;
}

@Controller('probe')
class ProbeController {
  /** A record-specific upload route that hands the receive's error straight up, as the portal proof routes do. */
  @Put('proof')
  put(): never {
    throw new ScanQueueDeferredError(version);
  }

  @Post('inbox')
  post(): never {
    throw new ScanQueueDeferredError(version);
  }

  @Post('plain-503')
  plain(): never {
    throw new ServiceUnavailableException();
  }

  @Post('downstream-503')
  downstream(): never {
    throw new DownstreamUnavailable('The payment gateway is not answering.');
  }

  @Post('version-shaped-503')
  versionShaped(): never {
    throw new VersionShapedUnavailable();
  }

  @Post('plain-error-503')
  plainError(): never {
    throw Object.assign(new Error('upstream down'), { status: 503 });
  }
}

const TENANT = randomUUID();
const ORG = randomUUID();
const caller: Principal = {
  userId: randomUUID(),
  zitadelUserId: 'zitadel-sub',
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: randomUUID(),
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map(),
};

/**
 * Stands in for CorrelationMiddleware + AuthGuard + TenancyInterceptor (global providers this module does not load): opens the
 * request store and binds an identity and principal, so the real handlers' principal() and requestTx() resolve.
 */
function bindTestCaller(_req: Request, _res: Response, next: NextFunction): void {
  runWithRequestStore('scan-deferred-corr', () => {
    bindIdentity({
      tenantId: TENANT,
      organizationId: ORG,
      orgKind: caller.orgKind,
      partyId: caller.partyId,
      idpOrgId: caller.idpOrgId,
      userId: caller.zitadelUserId,
      roles: caller.roles,
      departmentId: caller.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(caller);
    next();
  });
}

const deferred = (): Mock => vi.fn(async () => Promise.reject(new ScanQueueDeferredError(version)));

const documents = { receiveContent: deferred() };
const evidence = { receive: deferred() };
const bills = { receive: deferred() };
const proofs = { receiveForPortal: deferred(), receiveForStaff: deferred() };
const inbox = { receiveKycFile: deferred(), receiveQuotationFile: deferred(), receiveBillFile: deferred() };
const bank = { receive: deferred(), assertMayAttach: vi.fn() };

const RECORD = randomUUID();
const ACCOUNT = randomUUID();
const DOC = randomUUID();
const VER = randomUUID();
const FILE = Buffer.from('%PDF-1.4 deferred scan probe');

const tx = expect.objectContaining({
  scope: { tenantId: TENANT, organizationId: ORG },
  actor: expect.objectContaining({ kind: 'user', id: caller.userId }),
});
const src = expect.objectContaining({ method: 'PUT' });
const len = FILE.length;

/** [route label, controller, path, the mocked receive, the arguments the real handler must pass it]. */
const uploadRoutes: [string, Type, string, Mock, unknown[]][] = [
  [
    'documents upload',
    DocumentsController,
    `/v1/documents/${DOC}/versions/${VER}/content`,
    documents.receiveContent,
    [VER, src, len, { documentId: DOC }],
  ],
  [
    'sales order evidence',
    EvidenceDocumentsController,
    `/v1/sales-orders/${RECORD}/evidence-documents/${DOC}/versions/${VER}/content`,
    evidence.receive,
    ['sales_order', RECORD, DOC, VER, src, len],
  ],
  [
    'quotation version evidence',
    EvidenceDocumentsController,
    `/v1/sales-orders/quotation-versions/${RECORD}/evidence-documents/${DOC}/versions/${VER}/content`,
    evidence.receive,
    ['quotation_version', RECORD, DOC, VER, src, len],
  ],
  [
    'vendor bill evidence',
    EvidenceDocumentsController,
    `/v1/payables/bills/${RECORD}/evidence-documents/${DOC}/versions/${VER}/content`,
    evidence.receive,
    ['vendor_bill', RECORD, DOC, VER, src, len],
  ],
  [
    'rfq evidence',
    EvidenceDocumentsController,
    `/v1/procurement/rfqs/${RECORD}/evidence-documents/${DOC}/versions/${VER}/content`,
    evidence.receive,
    ['rfq', RECORD, DOC, VER, src, len],
  ],
  [
    'bill document',
    BillDocumentsController,
    `/v1/payables/bill-documents/${DOC}/versions/${VER}/content`,
    bills.receive,
    [DOC, VER, src, len],
  ],
  [
    'portal payment proof',
    PortalPaymentProofsController,
    `/v1/portal/payment-proofs/${DOC}/versions/${VER}/content`,
    proofs.receiveForPortal,
    [caller, tx, DOC, VER, src, len],
  ],
  [
    'staff payment proof',
    StaffPaymentProofsController,
    `/v1/payment-proofs/${DOC}/versions/${VER}/content`,
    proofs.receiveForStaff,
    [caller, tx, DOC, VER, src, len],
  ],
  [
    'vendor portal KYC file',
    VendorPortalInboxController,
    `/v1/portal/vendor/kyc-documents/files/${DOC}/versions/${VER}/content`,
    inbox.receiveKycFile,
    [tx, DOC, VER, src, len],
  ],
  [
    'vendor portal quotation file',
    VendorPortalInboxController,
    `/v1/portal/vendor/quotation-submissions/files/${DOC}/versions/${VER}/content`,
    inbox.receiveQuotationFile,
    [tx, DOC, VER, src, len],
  ],
  [
    'vendor portal bill file',
    VendorPortalInboxController,
    `/v1/portal/vendor/bill-submissions/files/${DOC}/versions/${VER}/content`,
    inbox.receiveBillFile,
    [tx, DOC, VER, src, len],
  ],
  [
    'vendor bank call-back evidence',
    VendorBankEvidenceController,
    `/v1/vendors/${RECORD}/bank-accounts/${ACCOUNT}/evidence/${DOC}/versions/${VER}/content`,
    bank.receive,
    [RECORD, ACCOUNT, DOC, VER, src, len],
  ],
];

describe('ScanQueueDeferredError over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  beforeAll(async () => {
    const controllers = [ProbeController, ...new Set(uploadRoutes.map(([, controller]) => controller))];
    const moduleRef = await Test.createTestingModule({
      controllers,
      providers: [
        { provide: DocumentsService, useValue: documents },
        { provide: DB, useValue: {} },
        { provide: EvidenceDocumentsService, useValue: evidence },
        { provide: BillDocumentsService, useValue: bills },
        { provide: PaymentProofsService, useValue: proofs },
        { provide: VendorPortalInboxService, useValue: inbox },
        { provide: VendorBankEvidenceService, useValue: bank },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(bindTestCaller);
    app.useGlobalFilters(new ErrorBodyFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['PUT', '/probe/proof'],
    ['POST', '/probe/inbox'],
  ])('answers 202 with the quarantined version on %s %s', async (method, path) => {
    const res = await (method === 'PUT' ? request(baseUrl).put(path) : request(baseUrl).post(path));
    expect(res.status).toBe(202);
    expect(res.body).toEqual(version);
  });

  it.each([
    ['a plain ServiceUnavailableException', '/probe/plain-503'],
    ['a ServiceUnavailableException subclass from another source', '/probe/downstream-503'],
    ['a 503 that carries a version field but is not the deferred error', '/probe/version-shaped-503'],
    ['a plain error with status 503', '/probe/plain-error-503'],
  ])('keeps %s a 503 with the error body', async (_label, path) => {
    const res = await request(baseUrl).post(path);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: expect.objectContaining({ code: expect.any(String) }) });
    expect(res.body).not.toHaveProperty('status');
    expect(res.body).not.toHaveProperty('id');
  });

  it.each(uploadRoutes)(
    'answers 202 with the quarantined version on the real %s route',
    async (_label, _controller, path, receive, expectedArgs) => {
      const res = await request(baseUrl)
        .put(path)
        .set('Content-Type', 'application/pdf')
        .set('Content-Length', String(FILE.length))
        .send(FILE);
      expect(res.status).toBe(202);
      expect(res.body).toEqual(version);
      // The real handler ran: it parsed the Content-Length and handed the request stream to the receive.
      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive).toHaveBeenCalledWith(...expectedArgs);
    },
  );
});
