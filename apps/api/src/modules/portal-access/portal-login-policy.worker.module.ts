// Portal login policy worker module: the boot-time reconcile that pins PORTAL_LOGIN_POLICY on every existing customer
// ZITADEL org. Imported only by WorkerModule, so the API process never runs it. Nothing a request needs lives here.
//
// ZitadelAdminClient comes from UsersCoreModule (the same client and credential the grant path uses), AuditService
// from AuditModule. DB comes from the global DbModule.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx } from '../../platform/db/tx';
import { UsersCoreModule } from '../../platform/users/users.core.module';
import { ZitadelAdminClient } from '../../platform/users/zitadel-admin.client';
import {
  drizzleLoginPolicyStore,
  LOGIN_POLICY_AUDIT,
  LOGIN_POLICY_STORE,
  LOGIN_POLICY_TX,
  LOGIN_POLICY_ZITADEL,
  PortalLoginPolicyReconciler,
  type RunInTx,
} from './portal-login-policy.reconciler';

@Module({
  imports: [AuditModule, UsersCoreModule],
  providers: [
    {
      provide: LOGIN_POLICY_STORE,
      inject: [DB],
      useFactory: (db: Db) => drizzleLoginPolicyStore(db),
    },
    {
      provide: LOGIN_POLICY_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn) =>
          withTx(db, scope, actor, fn),
    },
    { provide: LOGIN_POLICY_AUDIT, useExisting: AuditService },
    { provide: LOGIN_POLICY_ZITADEL, useExisting: ZitadelAdminClient },
    PortalLoginPolicyReconciler,
  ],
})
export class PortalLoginPolicyWorkerModule {}
