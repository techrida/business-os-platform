// Leads module (P2 C2a): leads, their stage machine and their conversion. Imports AuditModule for the domain events,
// SettingsModule for NumberingService (the LD and DEAL numbers) and CurrencyEnabledService (a lead's currency must be
// switched on, D44), and CustomersModule for CustomersService (the customer and contact a conversion creates);
// AuthzModule and the database are global.
// Only AppModule imports it: the worker has no lead routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { CustomersModule } from '../customers/customers.module';
import { LeadConvertController } from './convert/lead-convert.controller';
import { LeadConvertService } from './convert/lead-convert.service';
import { LeadsCaller } from './leads.caller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuditModule, SettingsModule, CustomersModule],
  controllers: [LeadsController, LeadConvertController],
  providers: [LeadsService, LeadConvertService, LeadsCaller],
  exports: [LeadsService],
})
export class LeadsModule {}
