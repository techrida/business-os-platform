import { Module } from '@nestjs/common';

import { ApprovalsWorkerModule } from './modules/approvals/approvals.worker.module';
import { EvidenceWorkerModule } from './modules/evidence/evidence.worker.module';
import { InvoiceRenderWorkerModule } from './modules/invoices/render/invoice-render.worker.module';
import { PortalLoginPolicyWorkerModule } from './modules/portal-access/portal-login-policy.worker.module';
import { PurchaseOrderRenderWorkerModule } from './modules/procurement/orders/render/purchase-order-render.worker.module';
import { QuotationExpiryWorkerModule } from './modules/quotations/expiry/quotation-expiry.worker.module';
import { QuotationRenderWorkerModule } from './modules/quotations/render/quotation-render.worker.module';
import { PaymentPromiseWorkerModule } from './modules/receivables/promises/payment-promise.worker.module';
import { PartyImportExpiryWorkerModule } from './modules/party-imports/party-import-expiry.worker.module';
import { VendorKycExpiryJobsModule } from './modules/vendors/vendor-kyc-expiry.worker.module';
import { AuditWorkerModule } from './platform/audit/audit.worker.module';
import { ConfigModule } from './platform/config/config.module';
import { DbModule } from './platform/db/db.module';
import { DocumentsWorkerModule } from './platform/documents/documents.worker.module';
import { NotifyWorkerModule } from './platform/notify/notify.worker.module';
import { ObsModule } from './platform/obs/obs.module';
import { QueueModule } from './platform/queue/queue.module';
import { HeartbeatScheduler, SystemProcessor } from './platform/queue/system.processor';
import { UsersWorkerModule } from './platform/users/users.worker.module';
import { WorkerHealth } from './platform/queue/worker-health';

/**
 * The BullMQ worker: no HTTP router, no auth. The processor and the heartbeat schedule live
 * here and not in QueueModule, so the API process never consumes jobs.
 *
 * The P1 kernel follows the same rule: each unit's processors go in its own *WorkerModule, listed
 * here. The HTTP modules (the ones with controllers) are never imported into the worker; a worker
 * module imports the service module it needs (e.g. SettingsModule, which has no worker module).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ service: 'worker' }),
    ObsModule.forRoot({ service: 'worker' }),
    DbModule,
    QueueModule,
    AuditWorkerModule,
    DocumentsWorkerModule,
    EvidenceWorkerModule,
    NotifyWorkerModule,
    UsersWorkerModule,
    ApprovalsWorkerModule,
    QuotationRenderWorkerModule,
    PurchaseOrderRenderWorkerModule,
    QuotationExpiryWorkerModule,
    InvoiceRenderWorkerModule,
    PortalLoginPolicyWorkerModule,
    VendorKycExpiryJobsModule,
    PaymentPromiseWorkerModule,
    PartyImportExpiryWorkerModule,
  ],
  providers: [SystemProcessor, HeartbeatScheduler, WorkerHealth],
})
export class WorkerModule {}
