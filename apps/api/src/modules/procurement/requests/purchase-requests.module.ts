// Purchase requests module (P4 unit P1): the REST routes, the service, and the registration of the purchase_request
// approval subject. Imports ApprovalsModule (the engine and its notify and caller ports), AuditModule and
// SettingsModule (NumberingService, MoneyService); the database and authz are global. onDecided is only called
// from ApprovalsService.act, which is an API route, so the worker never needs the subject. It also serves the
// departments lookup of the purchase request form (P4 unit P2e).
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersService } from './cost-centers.service';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { PurchaseRequestSubject } from './purchase-request.subject';
import { PurchaseRequestsCaller } from './purchase-requests.caller';
import { PurchaseRequestsController } from './purchase-requests.controller';
import { PurchaseRequestsService } from './purchase-requests.service';

@Module({
  imports: [ApprovalsModule, AuditModule, SettingsModule],
  controllers: [PurchaseRequestsController, DepartmentsController, CostCentersController],
  providers: [
    PurchaseRequestsService,
    PurchaseRequestsCaller,
    DepartmentsService,
    CostCentersService,
  ],
  exports: [PurchaseRequestsService],
})
export class PurchaseRequestsModule implements OnModuleInit {
  constructor(private readonly approvals: ApprovalsService) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(new PurchaseRequestSubject());
  }
}
