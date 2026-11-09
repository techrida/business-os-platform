// Verification module (P2 unit V): the KYB case of a customer. Imports what it calls: documents (the owner
// policy and the clean-scan check) and audit (domain events). AuthzModule and the database are global.
// Only AppModule imports this module: the worker has no verification jobs.
// It exports VerificationService, which the vendors module uses for the vendor KYB case.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { VerificationCaller } from './verification.caller';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

@Module({
  imports: [DocumentsModule, AuditModule],
  controllers: [VerificationController],
  providers: [VerificationService, VerificationCaller],
  exports: [VerificationService],
})
export class VerificationModule {}
