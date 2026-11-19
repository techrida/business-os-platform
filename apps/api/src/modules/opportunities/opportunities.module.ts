// Opportunities module (P2 C2b): the pipeline's deals and their stage machine. Imports AuditModule for the
// domain event of a stage change; AuthzModule and the database are global. It exports OpportunitiesService
// so the quotations module can call markQuotationSent and markWon and register its onLost handler. Only
// AppModule imports it: the worker has no opportunity routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { LeadsModule } from '../leads/leads.module';
import { OpportunitiesCaller } from './opportunities.caller';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  imports: [AuditModule, LeadsModule],
  controllers: [OpportunitiesController],
  providers: [OpportunitiesService, OpportunitiesCaller],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}
