import { Module } from '@nestjs/common';

import { ActivitiesModule } from './modules/activities/activities.module';
import { ApprovalsHttpModule } from './modules/approvals/approvals.module';
import { CustomersModule } from './modules/customers/customers.module';
import { LeadsModule } from './modules/leads/leads.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MeModule } from './modules/me/me.module';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module';
import { PortalModule } from './modules/portal/portal.module';
import { PortalAccessModule } from './modules/portal-access/portal-access.module';
import { VendorPortalModule } from './modules/portal-vendor/portal-vendor.module';
import { PurchaseOrdersModule } from './modules/procurement/orders/purchase-orders.module';
import { ReceiptsModule } from './modules/procurement/receipts/receipts.module';
import { PurchaseRequestsModule } from './modules/procurement/requests/purchase-requests.module';
import { SourcingModule } from './modules/procurement/sourcing/sourcing.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { TestMemoModule } from './modules/test-memo/test-memo.module';
import { VendorBankModule } from './modules/vendors/bank/bank.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { VerificationModule } from './modules/verification/verification.module';
import { AuditHttpModule } from './platform/audit/audit.module';
import { AuthModule } from './platform/auth/auth.module';
import { AuthzModule } from './platform/authz/authz.module';
import { ConfigModule } from './platform/config/config.module';
import { DbModule } from './platform/db/db.module';
import { DocumentsModule } from './platform/documents/documents.module';
import { HealthModule } from './platform/health/health.module';
import { NotifyHttpModule } from './platform/notify/notify.module';
import { ObsModule } from './platform/obs/obs.module';
import { QueueModule } from './platform/queue/queue.module';
import { SettingsHttpModule } from './platform/settings/settings.module';
import { TenancyModule } from './platform/tenancy/tenancy.module';
import { UsersModule } from './platform/users/users.module';

/**
 * The HTTP API. Import order matters in one place: TenancyModule comes before ObsModule because
 * Nest registers middleware in module order, and the correlation middleware must set
 * `req.correlationId` before pino-http's request-id generator reads it.
 * Config, Obs and Db are global, so the modules below inject their services without importing them.
 *
 * Only HTTP modules are listed here. Their BullMQ processors live in the matching *WorkerModule,
 * imported by WorkerModule alone, so the API process never consumes jobs.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ service: 'api' }),
    TenancyModule,
    ObsModule.forRoot({ service: 'api' }),
    DbModule,
    QueueModule,
    AuthModule,
    HealthModule,
    MeModule,
    TelemetryModule,
    // P1 kernel (stubs until each unit fills its module in).
    AuthzModule,
    AuditHttpModule,
    SettingsHttpModule,
    DocumentsModule,
    NotifyHttpModule,
    UsersModule,
    ApprovalsHttpModule,
    TestMemoModule,
    // P3: the AR/AP subledger writer.
    LedgerModule,
    CustomersModule,
    OpportunitiesModule,
    LeadsModule,
    ActivitiesModule,
    QuotationsModule,
    VerificationModule,
    PortalModule,
    VendorPortalModule,
    PortalAccessModule,
    // P4: procurement master data and requests.
    VendorsModule,
    VendorBankModule,
    PurchaseRequestsModule,
    SourcingModule,
    ReceiptsModule,
    PurchaseOrdersModule,
  ],
})
export class AppModule {}
