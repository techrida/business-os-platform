// The parts of k-users both processes need: the SQL store, the ZITADEL client, the mirror logic and
// the `users` queue. It has no controllers and imports nothing from platform/authz, so the worker
// (which has neither HTTP nor AuthzModule) can import it through UsersWorkerModule.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { UserMirror } from './user-mirror';
import { USERS_QUEUE } from './users.constants';
import { SqlUsersStore, UsersStore } from './users.store';
import { ZitadelAdminClient } from './zitadel-admin.client';

@Module({
  imports: [BullModule.registerQueue({ name: USERS_QUEUE })],
  providers: [{ provide: UsersStore, useClass: SqlUsersStore }, ZitadelAdminClient, UserMirror],
  exports: [UsersStore, ZitadelAdminClient, UserMirror, BullModule],
})
export class UsersCoreModule {}
