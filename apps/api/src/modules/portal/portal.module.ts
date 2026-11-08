// Customer portal module (P2 unit PA-2): the read routes of the customer's own quotations. Imports DocumentsModule
// (the rendered PDF's scan status) and SettingsModule (the issuer block); the database is global. The quotation
// version's document owner policy is registered by QuotationsModule.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { PortalCaller } from './portal.caller';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { DrizzlePortalQuotationStore, PORTAL_QUOTATION_STORE } from './portal.store';

@Module({
  imports: [DocumentsModule, SettingsModule],
  controllers: [PortalController],
  providers: [
    PortalService,
    PortalCaller,
    { provide: PORTAL_QUOTATION_STORE, useClass: DrizzlePortalQuotationStore },
  ],
})
export class PortalModule {}
