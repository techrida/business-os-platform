import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvoiceIssueService } from '../../invoices/invoice-issue.service';
import { InvoiceRenderNudge } from '../../invoices/render/invoice-render.nudge';
import { PurchaseOrdersModule } from '../../procurement/orders/purchase-orders.module';
import { PurchaseOrdersService } from '../../procurement/orders/purchase-orders.service';
import { PurchaseOrderRenderNudge } from '../../procurement/orders/render/purchase-order-render.nudge';
import { ApprovalsService } from '../../approvals/requests.service';
import { InvoiceDocumentService } from '../../invoices/render/invoice-document.service';
import { PurchaseOrderDocumentService } from '../../procurement/orders/render/purchase-order-document.service';
import { QuotationDocumentService } from '../document/quotation-document.service';
import { QuotationsModule } from '../quotations.module';
import { QuotationRenderNudge } from './quotation-render.nudge';

// Render on commit (S3): the commands take their render nudge as an optional dependency, so a module that forgets to
// import the nudge's module still boots, and quietly renders on the sweep alone. This compiles the real AppModule and
// checks each command service got its nudge. compile() never calls init(): no queue connects, no pool opens.
describe('render nudges on the real AppModule (DI graph)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // ConfigModule.forRoot() reads process.env when app.module is evaluated, so set it first.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      VALKEY_URL: 'redis://127.0.0.1:1',
      OIDC_ISSUER: 'http://127.0.0.1:1',
      OIDC_AUDIENCE: 'render-nudge-boot',
      OIDC_CLIENT_ID: 'render-nudge-client',
      // CryptoModule (vendor bank accounts) throws at boot without a keyring.
      FIELD_ENC_KEYS: 'k1:' + randomBytes(32).toString('base64'),
    });
    const { AppModule } = await import('../../../app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('gives InvoiceIssueService the invoice render nudge', () => {
    const issuing = moduleRef.get(InvoiceIssueService, { strict: false });
    expect((issuing as unknown as { renderNudge?: unknown }).renderNudge).toBeInstanceOf(
      InvoiceRenderNudge,
    );
  });

  it('gives PurchaseOrdersService and the po_amendment subject the purchase order render nudge', () => {
    const orders = moduleRef.get(PurchaseOrdersService, { strict: false });
    expect((orders as unknown as { renderNudge?: unknown }).renderNudge).toBeInstanceOf(
      PurchaseOrderRenderNudge,
    );
    // The subject is registered in onModuleInit, which compile() does not run: run it as Nest would.
    const approvals = moduleRef.get(ApprovalsService, { strict: false });
    moduleRef.get(PurchaseOrdersModule, { strict: false }).onModuleInit();
    const subject = (approvals as unknown as { subjectOf(t: string): unknown }).subjectOf(
      'po_amendment',
    );
    expect((subject as { renderNudge?: unknown }).renderNudge).toBeInstanceOf(
      PurchaseOrderRenderNudge,
    );
  });

  it('gives each document service its render nudge, so a Retry renders at once', () => {
    const nudgeOf = (service: unknown) => (service as { renderNudge?: unknown }).renderNudge;
    expect(nudgeOf(moduleRef.get(QuotationDocumentService, { strict: false }))).toBeInstanceOf(
      QuotationRenderNudge,
    );
    expect(nudgeOf(moduleRef.get(InvoiceDocumentService, { strict: false }))).toBeInstanceOf(
      InvoiceRenderNudge,
    );
    expect(nudgeOf(moduleRef.get(PurchaseOrderDocumentService, { strict: false }))).toBeInstanceOf(
      PurchaseOrderRenderNudge,
    );
  });

  it('gives the quotation_version subject the quotation render nudge', () => {
    const approvals = moduleRef.get(ApprovalsService, { strict: false });
    moduleRef.get(QuotationsModule, { strict: false }).onModuleInit();
    const subject = (approvals as unknown as { subjectOf(t: string): unknown }).subjectOf(
      'quotation_version',
    );
    expect((subject as { renderNudge?: unknown }).renderNudge).toBeInstanceOf(QuotationRenderNudge);
  });
});
