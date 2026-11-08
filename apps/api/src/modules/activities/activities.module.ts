// Activities module (P2 C2a): the log of calls, meetings, emails, notes and tasks on CRM records. Imports
// AuditModule for the domain event; AuthzModule and the database are global. Only AppModule imports it: the
// worker has no activity routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { ActivitiesCaller } from './activities.caller';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

@Module({
  imports: [AuditModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService, ActivitiesCaller],
})
export class ActivitiesModule {}
