// Approvals module (owner: U7): workflow definitions, routing and approval requests.
// ApprovalsService is exported so document modules (test-memo in P1) can register as a subject and
// submit. Serves the NFR "approvals are auditable" by keeping the engine in one place.
//
// Two modules on purpose, like audit. ApprovalsModule holds the engine only, so the worker can import
// it without registering HTTP routes. ApprovalsHttpModule adds the controllers and AuthModule (the
// ID-token verifier for step-up, K7, which needs the API-only AppConfig), and only AppModule imports it.
//
// The engine depends on two small ports (ports.ts) that the kernel's AuditService and NotifyService
// satisfy structurally, so its unit tests can use fakes. UserDirectory comes from the global UsersModule.
import { Module } from '@nestjs/common';

import {
  AdminApprovalGroupsController,
  AdminDelegationsController,
  AdminWorkflowsController,
} from './admin-workflows.controller';
import { ApprovalsAdminService } from './admin.service';
import { ApprovalsController } from './approvals.controller';
import { AuditModule } from '../../platform/audit/audit.module';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthModule } from '../../platform/auth/auth.module';
import { STEP_UP_MAX_AGE_SECONDS, stepUpMaxAgeFromEnv } from '../../platform/auth/step-up';
import { NotifyModule } from '../../platform/notify/notify.module';
import { NotifyService } from '../../platform/notify/notify.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import {
  APPROVALS_CLOCK,
  ApprovalsAudit,
  ApprovalsCaller,
  ApprovalsNotify,
  type Clock,
} from './ports';
import { ApprovalsService } from './requests.service';

@Module({
  // SettingsModule: the admin service reads `approvals.sla_defaults` for specs that leave `sla` out.
  imports: [AuditModule, NotifyModule, SettingsModule],
  providers: [
    ApprovalsService,
    ApprovalsAdminService,
    ApprovalsCaller,
    { provide: APPROVALS_CLOCK, useValue: (() => new Date()) satisfies Clock },
    { provide: ApprovalsAudit, useExisting: AuditService },
    { provide: ApprovalsNotify, useExisting: NotifyService },
  ],
  exports: [
    ApprovalsService,
    ApprovalsAdminService,
    ApprovalsCaller,
    APPROVALS_CLOCK,
    ApprovalsAudit,
    ApprovalsNotify,
  ],
})
export class ApprovalsModule {}

@Module({
  imports: [ApprovalsModule, AuthModule],
  controllers: [
    ApprovalsController,
    AdminWorkflowsController,
    AdminApprovalGroupsController,
    AdminDelegationsController,
  ],
  providers: [
    // K7: how recent a sign-in a Founder decision needs. Read once at startup; a bad value stops boot.
    {
      provide: STEP_UP_MAX_AGE_SECONDS,
      useFactory: () => stepUpMaxAgeFromEnv(process.env.STEP_UP_MAX_AGE_SECONDS),
    },
  ],
})
export class ApprovalsHttpModule {}
