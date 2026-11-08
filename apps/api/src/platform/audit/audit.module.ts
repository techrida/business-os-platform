// Audit kernel: the hash-chained audit trail's service and its read routes.
//
// Two modules on purpose, like settings. AuditModule holds AuditService only, so other kernel modules and the
// worker can import it without registering HTTP routes. AuditHttpModule adds the controller, and only
// AppModule imports it.
import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

@Module({
  imports: [AuditModule],
  controllers: [AuditController],
})
export class AuditHttpModule {}
