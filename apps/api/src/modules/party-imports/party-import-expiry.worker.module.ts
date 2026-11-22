// Party import preview expiry worker module (round 5, FU11): the sweeper, its processor and its schedule. Imported only
// by WorkerModule, so the API process never expires anything. AuditService comes from AuditModule; the database is global.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import {
  PARTY_IMPORT_EXPIRY_QUEUE,
  PartyImportExpiryProcessor,
  PartyImportExpiryScheduler,
  PartyImportExpirySweeper,
} from './party-import-expiry.sweeper';

@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: PARTY_IMPORT_EXPIRY_QUEUE })],
  providers: [PartyImportExpirySweeper, PartyImportExpiryProcessor, PartyImportExpiryScheduler],
})
export class PartyImportExpiryWorkerModule {}
