// Customer portal billing module (P3 unit U13): the invoice reads under `v1/portal/invoices`, the payment list and
// submit under `v1/portal/payments`, and the milestones (sales-order billing schedule, F1-Q34) under
// `v1/portal/sales-orders`. Imports DocumentsModule (the invoice PDF's scan status and its signed link),
// PaymentsModule (PaymentsService.submit) and SettingsModule (the seller contact); the database is global. The `invoice` document owner policy is registered
// by InvoicesModule. PortalCaller and PortalTxActor have no dependencies, so they are provided here too rather than
// exported from PortalModule.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { PaymentsModule } from '../payments/payments.module';
import { PortalCaller, PortalTxActor } from '../portal/portal.caller';
import { PortalBillingController } from './portal-billing.controller';
import { PortalBillingService } from './portal-billing.service';
import { PortalMilestonesController } from './portal-milestones.controller';
import { PortalMilestonesService } from './portal-milestones.service';
import { PortalPaymentsController } from './portal-payments.controller';
import { PortalPaymentsService } from './portal-payments.service';

@Module({
  imports: [DocumentsModule, PaymentsModule, SettingsModule],
  controllers: [PortalBillingController, PortalPaymentsController, PortalMilestonesController],
  providers: [
    PortalBillingService,
    PortalPaymentsService,
    PortalMilestonesService,
    PortalCaller,
    PortalTxActor,
  ],
})
export class PortalBillingModule {}
