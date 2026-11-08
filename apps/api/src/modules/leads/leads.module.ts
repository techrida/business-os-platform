// Leads module (P2 C2a): leads, their stage machine and (a later unit) conversion. Imports AuditModule for the
// domain events and SettingsModule for NumberingService (the LD number); AuthzModule and the database are global.
// Only AppModule imports it: the worker has no lead routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { LeadsCaller } from './leads.caller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsCaller],
  exports: [LeadsService],
})
export class LeadsModule {}
