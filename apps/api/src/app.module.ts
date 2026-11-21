import { Module } from '@nestjs/common';

import { AccessSettingsModule } from './modules/access-settings/access-settings.module';
import { ActivitiesModule } from './modules/activities/activities.module';
import { ApprovalsHttpModule } from './modules/approvals/approvals.module';
import { CompanyAccountsModule } from './modules/company-accounts/company-accounts.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DepartmentsAdminModule } from './modules/departments/departments.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { ImagesModule } from './modules/images/images.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { InvoiceRenderModule } from './modules/invoices/render/invoice-render.module';
import { LeadsModule } from './modules/leads/leads.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MeModule } from './modules/me/me.module';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module';
import { PaymentProofsModule } from './modules/payment-proofs/payment-proofs.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { BillSubmissionsModule } from './modules/payables/bills/bill-submissions.module';
import { VendorBillsModule } from './modules/payables/bills/vendor-bills.module';
import { PaymentRequestsModule } from './modules/payables/payment-requests/payment-requests.module';
import { PortalModule } from './modules/portal/portal.module';
import { PortalAccessModule } from './modules/portal-access/portal-access.module';
import { PortalBillingModule } from './modules/portal-billing/portal-billing.module';
import { VendorPortalInboxModule } from './modules/portal-vendor/inbox/portal-vendor-inbox.module';
import { VendorPortalModule } from './modules/portal-vendor/portal-vendor.module';
import { PurchaseOrdersModule } from './modules/procurement/orders/purchase-orders.module';
import { PurchaseOrderRenderModule } from './modules/procurement/orders/render/purchase-order-render.module';
import { ReceiptsModule } from './modules/procurement/receipts/receipts.module';
import { PurchaseRequestsModule } from './modules/procurement/requests/purchase-requests.module';
import { SourcingModule } from './modules/procurement/sourcing/sourcing.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { SalesOrdersModule } from './modules/sales-orders/sales-orders.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { TestMemoModule } from './modules/test-memo/test-memo.module';
import { VendorBankModule } from './modules/vendors/bank/bank.module';
import { PartyImportsModule } from './modules/party-imports/party-imports.module';
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
    AccessSettingsModule,
    DepartmentsAdminModule,
    ApprovalsHttpModule,
    TestMemoModule,
    // P3: the AR/AP subledger writer.
    LedgerModule,
    SalesOrdersModule,
    PaymentsModule,
    PaymentProofsModule,
    ReceivablesModule,
    PortalBillingModule,
    InvoicesModule,
    InvoiceRenderModule,
    CustomersModule,
    OpportunitiesModule,
    LeadsModule,
    ActivitiesModule,
    QuotationsModule,
    VerificationModule,
    PortalModule,
    VendorPortalModule,
    VendorPortalInboxModule,
    PortalAccessModule,
    // P4: procurement master data and requests.
    VendorsModule,
    PartyImportsModule,
    VendorBankModule,
    PurchaseRequestsModule,
    SourcingModule,
    ReceiptsModule,
    PurchaseOrdersModule,
    PurchaseOrderRenderModule,
    VendorBillsModule,
    BillSubmissionsModule,
    PaymentRequestsModule,
    // Round 5: the entity's bank and expense accounts (Settings > Finance) and their lookup.
    CompanyAccountsModule,
    // U12: logos and profile pictures as documents.
    ImagesModule,
    // Round 5 P2: evidence uploaded in place on a sales order, vendor bill or RFQ.
    EvidenceModule,
  ],
})
export class AppModule {}
