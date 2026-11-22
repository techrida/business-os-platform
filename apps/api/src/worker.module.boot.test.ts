import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApprovalsSlaProcessor, ApprovalsSlaScheduler } from './modules/approvals/sla.processor';
import { PortalLoginPolicyReconciler } from './modules/portal-access/portal-login-policy.reconciler';
import { PortalLoginPolicyWorkerModule } from './modules/portal-access/portal-login-policy.worker.module';
import {
  QuotationExpiryProcessor,
  QuotationExpiryScheduler,
  QuotationExpirySweeper,
} from './modules/quotations/expiry/quotation-expiry.sweeper';
import { QuotationExpiryWorkerModule } from './modules/quotations/expiry/quotation-expiry.worker.module';
import { QUOTATION_OWNER_TYPE } from './modules/quotations/quotation-owner.policy';
import {
  QuotationRenderProcessor,
  QuotationRenderScheduler,
  QuotationRenderSweeper,
} from './modules/quotations/render/quotation-render.sweeper';
import { QuotationRenderWorkerModule } from './modules/quotations/render/quotation-render.worker.module';
import {
  PaymentPromiseProcessor,
  PaymentPromiseScheduler,
  PaymentPromiseSweeper,
} from './modules/receivables/promises/payment-promise.sweeper';
import type { DocumentOwnerPolicy } from './platform/documents/documents.ports';
import { DocumentsService } from './platform/documents/documents.service';
import { OutboxDrainer } from './platform/notify/outbox.drainer';
import { OutboxDrainScheduler, OutboxProcessor } from './platform/notify/outbox.processor';
import {
  PartyImportExpiryProcessor,
  PartyImportExpiryScheduler,
  PartyImportExpirySweeper,
} from './modules/party-imports/party-import-expiry.sweeper';
import { UserLocks } from './platform/users/user-locks';
import { UsersProcessor } from './platform/users/users.processor';

// WorkerModule boot check. The worker-only modules (render sweeper, quotation expiry, approvals SLA,
// notify outbox) are imported by nothing but WorkerModule, so no other test compiles them and a missing or
// mis-scoped provider there would only show up when the worker process starts. This compiles the real
// graph, with the real ConfigModule, DbModule and QueueModule.
//
// compile() instantiates providers but never calls init(): no BullMQ worker starts polling, no scheduler
// enqueues its repeatable job, the lazy pg pool opens no connection. The URLs point at a closed port.
// The one lifecycle hook the test calls by hand is QuotationRenderWorkerModule.onModuleInit, because that is
// where the quotation_version document owner gets registered.
describe('WorkerModule boot (DI graph)', () => {
  let moduleRef: TestingModule;
  let WorkerModule: typeof import('./worker.module').WorkerModule;

  beforeAll(async () => {
    // ConfigModule.forRoot() reads process.env when worker.module is evaluated, so set it first.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      VALKEY_URL: 'redis://127.0.0.1:1',
      GOTENBERG_URL: 'http://127.0.0.1:1',
      FILES_ROOT: 'worker-boot-test-files',
    });
    ({ WorkerModule } = await import('./worker.module'));
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('compiles and resolves the render sweeper, processor and scheduler', () => {
    expect(moduleRef.get(QuotationRenderSweeper, { strict: false })).toBeInstanceOf(
      QuotationRenderSweeper,
    );
    expect(moduleRef.get(QuotationRenderProcessor, { strict: false })).toBeInstanceOf(
      QuotationRenderProcessor,
    );
    expect(moduleRef.get(QuotationRenderScheduler, { strict: false })).toBeInstanceOf(
      QuotationRenderScheduler,
    );
  });

  it('resolves the quotation expiry sweeper, processor and scheduler', () => {
    expect(moduleRef.get(QuotationExpirySweeper, { strict: false })).toBeInstanceOf(
      QuotationExpirySweeper,
    );
    expect(moduleRef.get(QuotationExpiryProcessor, { strict: false })).toBeInstanceOf(
      QuotationExpiryProcessor,
    );
    expect(moduleRef.get(QuotationExpiryScheduler, { strict: false })).toBeInstanceOf(
      QuotationExpiryScheduler,
    );
    // The module class itself is a provider too: it only exists if the module's imports resolved.
    expect(moduleRef.get(QuotationExpiryWorkerModule, { strict: false })).toBeInstanceOf(
      QuotationExpiryWorkerModule,
    );
  });

  it('resolves the payment-promise sweeper, processor and scheduler', () => {
    expect(moduleRef.get(PaymentPromiseSweeper, { strict: false })).toBeInstanceOf(
      PaymentPromiseSweeper,
    );
    expect(moduleRef.get(PaymentPromiseProcessor, { strict: false })).toBeInstanceOf(
      PaymentPromiseProcessor,
    );
    expect(moduleRef.get(PaymentPromiseScheduler, { strict: false })).toBeInstanceOf(
      PaymentPromiseScheduler,
    );
  });

  it('resolves the party import expiry sweeper, processor and scheduler', () => {
    expect(moduleRef.get(PartyImportExpirySweeper, { strict: false })).toBeInstanceOf(
      PartyImportExpirySweeper,
    );
    expect(moduleRef.get(PartyImportExpiryProcessor, { strict: false })).toBeInstanceOf(
      PartyImportExpiryProcessor,
    );
    expect(moduleRef.get(PartyImportExpiryScheduler, { strict: false })).toBeInstanceOf(
      PartyImportExpiryScheduler,
    );
  });

  it('resolves the portal login policy reconciler', () => {
    expect(moduleRef.get(PortalLoginPolicyReconciler, { strict: false })).toBeInstanceOf(
      PortalLoginPolicyReconciler,
    );
    expect(moduleRef.get(PortalLoginPolicyWorkerModule, { strict: false })).toBeInstanceOf(
      PortalLoginPolicyWorkerModule,
    );
  });

  it('resolves the users processor with the timed-lock service (F1-Q4)', () => {
    expect(moduleRef.get(UserLocks, { strict: false })).toBeInstanceOf(UserLocks);
    expect(moduleRef.get(UsersProcessor, { strict: false })).toBeInstanceOf(UsersProcessor);
  });

  it('resolves the approvals SLA processor and scheduler', () => {
    expect(moduleRef.get(ApprovalsSlaProcessor, { strict: false })).toBeInstanceOf(
      ApprovalsSlaProcessor,
    );
    expect(moduleRef.get(ApprovalsSlaScheduler, { strict: false })).toBeInstanceOf(
      ApprovalsSlaScheduler,
    );
  });

  it('resolves the notify outbox drainer, processor and scheduler', () => {
    expect(moduleRef.get(OutboxDrainer, { strict: false })).toBeInstanceOf(OutboxDrainer);
    expect(moduleRef.get(OutboxProcessor, { strict: false })).toBeInstanceOf(OutboxProcessor);
    expect(moduleRef.get(OutboxDrainScheduler, { strict: false })).toBeInstanceOf(
      OutboxDrainScheduler,
    );
  });

  it('gives the render worker module its own DocumentsService, with the quotation_version owner registered', () => {
    const renderModuleRef = moduleRef.select(WorkerModule).select(QuotationRenderWorkerModule);
    const documents = renderModuleRef.get(DocumentsService, { strict: true });
    expect(documents).toBeInstanceOf(DocumentsService);

    // compile() skips lifecycle hooks, so run the one that registers the owner, as init() would.
    renderModuleRef.get(QuotationRenderWorkerModule).onModuleInit();

    // registerOwner refuses a duplicate owner type. That it does here proves the quotation policy
    // landed on this module's DocumentsService, the one the render sweeper calls.
    expect(() => {
      documents.registerOwner({ ownerType: QUOTATION_OWNER_TYPE } as DocumentOwnerPolicy);
    }).toThrow(`document owner type "${QUOTATION_OWNER_TYPE}" is already registered`);
  });
});
