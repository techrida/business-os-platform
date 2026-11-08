// Quotations module (P2 unit Q1): registers how quotation-version files are authorized, provides PricingService,
// DraftingService and ReviseService, and serves drafting, revise, preview and reference routes. Imports
// DocumentsModule, SettingsModule (MoneyService, NumberingService, SettingsService), ApprovalsModule (preview
// route, approval cancel on revise), AuditModule, OpportunitiesModule (markQuotationSent on send) and NotifyModule
// (the customer email on send); the database is global.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { AuditModule } from '../../platform/audit/audit.module';
import { NotifyModule } from '../../platform/notify/notify.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ApprovalsService } from '../approvals/requests.service';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { QuotationVersionSubject } from './approval/quotation-version.subject';
import { QuotationSubmitCaller } from './approval/quotation-submit.caller';
import { QuotationSubmitController } from './approval/quotation-submit.controller';
import { QuotationSubmitService, QuotationSubmitStore } from './approval/quotation-submit.service';
import { DraftingCaller } from './drafting/drafting.caller';
import { DraftingController } from './drafting/drafting.controller';
import { DraftingService } from './drafting/drafting.service';
import { ReviseController } from './drafting/revise.controller';
import { ReviseService } from './drafting/revise.service';
import { PricingService } from './pricing/pricing.service';
import { QuotationPreviewCaller } from './preview/quotation-preview.caller';
import { QuotationPreviewController } from './preview/quotation-preview.controller';
import { QuotationPreviewService } from './preview/quotation-preview.service';
import { drizzleHeadLoader, QuotationOwnerPolicy } from './quotation-owner.policy';
import { ReferenceCaller } from './reference/reference.caller';
import { ReferenceController } from './reference/reference.controller';
import { ReferenceService } from './reference/reference.service';
import { QuotationSendCaller } from './send/quotation-send.caller';
import { QuotationSendController } from './send/quotation-send.controller';
import { QuotationSendService, QuotationSendStore } from './send/quotation-send.service';

@Module({
  imports: [
    ApprovalsModule,
    AuditModule,
    DocumentsModule,
    NotifyModule,
    OpportunitiesModule,
    SettingsModule,
  ],
  controllers: [
    DraftingController,
    ReferenceController,
    QuotationPreviewController,
    ReviseController,
    QuotationSubmitController,
    QuotationSendController,
  ],
  providers: [
    PricingService,
    DraftingService,
    DraftingCaller,
    ReferenceCaller,
    ReferenceService,
    QuotationPreviewService,
    QuotationPreviewCaller,
    ReviseService,
    QuotationSubmitService,
    QuotationSubmitStore,
    QuotationSubmitCaller,
    QuotationSendService,
    QuotationSendStore,
    QuotationSendCaller,
  ],
  exports: [PricingService],
})
export class QuotationsModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Both registries throw on a duplicate, so this runs once, when the module starts. onDecided is only called from
   * ApprovalsService.act, which is an API route, so the worker never needs the subject.
   */
  onModuleInit(): void {
    this.documents.registerOwner(new QuotationOwnerPolicy(drizzleHeadLoader(this.db)));
    this.approvals.registerSubject(new QuotationVersionSubject());
  }
}
