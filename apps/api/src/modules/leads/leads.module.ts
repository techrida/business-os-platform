// Leads module (P2 C2a): leads, their stage machine and their conversion. Imports AuditModule for the domain events,
// SettingsModule for NumberingService (the LD and DEAL numbers) and CurrencyEnabledService (a lead's currency must be
// switched on, D44), CustomersModule for CustomersService (the customer and contact a conversion creates), and
// NotifyModule for NotifyService (a lead handed to someone tells them, #22; NotifyModule is not global). AuthzModule
// (AuthzService, RoleCache) and the database are global.
// Only AppModule imports it: the worker has no lead routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { NotifyModule } from '../../platform/notify/notify.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { CustomersModule } from '../customers/customers.module';
import { LeadConvertController } from './convert/lead-convert.controller';
import { LeadConvertService } from './convert/lead-convert.service';
import { LeadDuplicatesController } from './lead-duplicates.controller';
import { LeadDuplicatesService } from './lead-duplicates.service';
import { LeadsCaller } from './leads.caller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadLostReasonsController } from './lost-reasons.controller';
import { LeadLostReasonsService } from './lost-reasons.service';

@Module({
  imports: [AuditModule, SettingsModule, CustomersModule, NotifyModule],
  // LeadDuplicatesController first: its GET duplicates must register before LeadsController's GET ':id'.
  controllers: [
    LeadDuplicatesController,
    LeadsController,
    LeadLostReasonsController,
    LeadConvertController,
  ],
  providers: [
    LeadsService,
    LeadLostReasonsService,
    LeadConvertService,
    LeadsCaller,
    LeadDuplicatesService,
  ],
  exports: [LeadsService, LeadLostReasonsService],
})
export class LeadsModule {}
