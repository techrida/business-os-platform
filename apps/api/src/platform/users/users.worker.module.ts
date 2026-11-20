// Users worker module (U6a): the users.sync, users.reconcile and users.lock-expiry processor plus their schedules.
// Imported only by WorkerModule. It takes UsersCoreModule, not UsersModule, because UsersModule has
// controllers and needs AppConfig and AuthzService, which the worker does not provide.
//
// Global and providing UserDirectory for the same reason UsersModule is in the API: worker-side
// kernel code (notify's notifyRole, the approvals SLA escalation) injects the port to find users by
// role. UsersService has only type imports from platform/authz, so this pulls in no AuthzModule.
import { Global, Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { UserDirectory } from '../authz/user-directory';
import { UserLocks } from './user-locks';
import { UsersCoreModule } from './users.core.module';
import { UsersProcessor, UsersReconcileScheduler } from './users.processor';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [UsersCoreModule, AuditModule],
  providers: [
    UsersProcessor,
    UsersReconcileScheduler,
    UserLocks,
    UsersService,
    { provide: UserDirectory, useExisting: UsersService },
  ],
  exports: [UsersService, UserDirectory],
})
export class UsersWorkerModule {}
