// Approvals worker module (owner: U7): the approvals.sla processor and its 5-minute schedule.
// Imported only by WorkerModule, so the API process never runs the tick. Serves the NFR "approvals do
// not stall silently" (reminders and escalations).
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ApprovalsModule } from './approvals.module';
import {
  APPROVALS_QUEUE,
  ApprovalsSlaProcessor,
  ApprovalsSlaScheduler,
  ApprovalsSlaService,
} from './sla.processor';

@Module({
  imports: [ApprovalsModule, BullModule.registerQueue({ name: APPROVALS_QUEUE })],
  providers: [ApprovalsSlaService, ApprovalsSlaProcessor, ApprovalsSlaScheduler],
})
export class ApprovalsWorkerModule {}
