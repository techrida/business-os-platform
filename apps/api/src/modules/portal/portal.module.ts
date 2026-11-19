// Customer portal module (P2 unit PA-2): the read routes of the customer's own quotations. Imports DocumentsModule
// (the rendered PDF's scan status) and SettingsModule (the issuer block); the database is global. The quotation
// version's document owner policy is registered by QuotationsModule.
// PA-3 adds accept and reject: QuotationsModule exports the outcome core (QuotationOutcomeService), NotifyModule the
// nudge after commit.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { NotifyModule } from '../../platform/notify/notify.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { QuotationsModule } from '../quotations/quotations.module';
import { PortalRespondController } from './portal-respond.controller';
import { PortalRespondService } from './portal-respond.service';
import { PortalCaller, PortalTxActor } from './portal.caller';
import { PortalController, PortalDisplayController } from './portal.controller';
import { PortalService } from './portal.service';
import {
  DrizzlePortalQuotationStore,
  DrizzlePortalRespondStore,
  PORTAL_QUOTATION_STORE,
  PORTAL_RESPOND_STORE,
} from './portal.store';

@Module({
  imports: [DocumentsModule, SettingsModule, QuotationsModule, NotifyModule],
  controllers: [PortalController, PortalDisplayController, PortalRespondController],
  providers: [
    PortalService,
    PortalRespondService,
    PortalCaller,
    PortalTxActor,
    { provide: PORTAL_QUOTATION_STORE, useClass: DrizzlePortalQuotationStore },
    { provide: PORTAL_RESPOND_STORE, useClass: DrizzlePortalRespondStore },
  ],
})
export class PortalModule {}
