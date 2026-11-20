// Opportunities module (P2 C2b): the pipeline's deals and their stage machine. Imports AuditModule for the
// domain event of a stage change; AuthzModule and the database are global. It exports OpportunitiesService
// so the quotations module can call markQuotationSent and markWon and register its onLost handler. The owner filter
// has a provider of its own (it reads the global RoleCache). Only AppModule imports it: the worker has no
// opportunity routes. NotifyModule (not global) carries the owner change's `crm.assigned` notice (F1-Q51).
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { NotifyModule } from '../../platform/notify/notify.module';
import { LeadsModule } from '../leads/leads.module';
import { OpportunitiesCaller } from './opportunities.caller';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityOwnerChangeController } from './opportunity-owner-change.controller';
import { OpportunityOwnerChangeService } from './opportunity-owner-change.service';
import { OpportunityOwnersService } from './opportunity-owners.service';

@Module({
  imports: [AuditModule, LeadsModule, NotifyModule],
  controllers: [OpportunitiesController, OpportunityOwnerChangeController],
  providers: [
    OpportunitiesService,
    OpportunitiesCaller,
    OpportunityOwnersService,
    OpportunityOwnerChangeService,
  ],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}
