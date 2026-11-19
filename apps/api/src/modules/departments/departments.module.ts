// Departments admin module (U20b / US-106). Imports AuditModule for domain events; AuthzModule and
// DbModule are global. Exports DepartmentsAdminService and ACCESS_REVISION_PORT so B2 can wire in
// its shared access revision store or reuse the service.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { ACCESS_REVISION_PORT, SettingsAccessRevisionStore } from './access-revision.port';
import { DepartmentsCaller } from './departments.caller';
import { DepartmentsAdminController } from './departments.controller';
import { DepartmentsAdminService } from './departments.service';

@Module({
  imports: [AuditModule],
  controllers: [DepartmentsAdminController],
  providers: [
    DepartmentsCaller,
    DepartmentsAdminService,
    SettingsAccessRevisionStore,
    { provide: ACCESS_REVISION_PORT, useExisting: SettingsAccessRevisionStore },
  ],
  exports: [DepartmentsAdminService, ACCESS_REVISION_PORT],
})
export class DepartmentsAdminModule {}
