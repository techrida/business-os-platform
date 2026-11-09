// Customer portal billing module (P3 unit U13): the invoice reads under `v1/portal/invoices`. Imports DocumentsModule
// (the invoice PDF's scan status and its signed link); the database is global. The `invoice` document owner policy is
// registered by InvoicesModule. PortalCaller has no dependencies, so it is provided here too rather than exported from
// PortalModule.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { PortalCaller } from '../portal/portal.caller';
import { PortalBillingController } from './portal-billing.controller';
import { PortalBillingService } from './portal-billing.service';

@Module({
  imports: [DocumentsModule],
  controllers: [PortalBillingController],
  providers: [PortalBillingService, PortalCaller],
})
export class PortalBillingModule {}
