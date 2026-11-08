// Approvals module (owner: U7): workflow definitions, routing and approval requests (HTTP side).
// ApprovalsService is exported so document modules (test-memo in P1) can register as a subject and
// submit. Serves the NFR "approvals are auditable" by keeping the engine in one place.
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
import { NotifyModule } from '../../platform/notify/notify.module';
import { NotifyService } from '../../platform/notify/notify.service';
import {
  APPROVALS_CLOCK,
  ApprovalsAudit,
  ApprovalsCaller,
  ApprovalsNotify,
  type Clock,
} from './ports';
import { ApprovalsService } from './requests.service';

@Module({
  imports: [AuditModule, NotifyModule],
  controllers: [
    ApprovalsController,
    AdminWorkflowsController,
    AdminApprovalGroupsController,
    AdminDelegationsController,
  ],
  providers: [
    ApprovalsService,
    ApprovalsAdminService,
    ApprovalsCaller,
    { provide: APPROVALS_CLOCK, useValue: (() => new Date()) satisfies Clock },
    { provide: ApprovalsAudit, useExisting: AuditService },
    { provide: ApprovalsNotify, useExisting: NotifyService },
  ],
  exports: [ApprovalsService, APPROVALS_CLOCK, ApprovalsAudit, ApprovalsNotify],
})
export class ApprovalsModule {}
