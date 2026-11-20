// Users module (U6a): the ZITADEL user mirror, admin user routes and the ZITADEL webhook (HTTP side).
// Global because U1's tenancy interceptor injects the UserDirectory port, and every kernel module that
// looks up approvers or emails (notify, approvals) injects it too, without importing this module.
// Imported by AppModule only; the worker uses UsersWorkerModule.
import { Global, Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { UserDirectory } from '../authz/user-directory';
import { AdminUsersController } from './admin-users.controller';
import { HooksController } from './hooks.controller';
import { UserStatusService } from './user-status';
import { UsersCoreModule } from './users.core.module';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [UsersCoreModule, AuditModule],
  controllers: [HooksController, AdminUsersController],
  providers: [
    UsersService,
    UserStatusService,
    { provide: UserDirectory, useExisting: UsersService },
  ],
  exports: [UsersService, UserDirectory],
})
export class UsersModule {}
