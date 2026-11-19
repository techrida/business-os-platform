// Nest module wiring for Access Settings (U20b).
// Imports AuditModule for transactional audit recording; DbModule and AuthzModule are global.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { AccessSettingsController } from './access-settings.controller';
import { AccessSettingsService } from './access-settings.service';

@Module({
  imports: [AuditModule],
  controllers: [AccessSettingsController],
  providers: [AccessSettingsService],
  exports: [AccessSettingsService],
})
export class AccessSettingsModule {}
