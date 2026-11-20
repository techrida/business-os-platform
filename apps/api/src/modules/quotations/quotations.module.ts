// Quotations module (P2 unit Q1): registers how quotation-version files are authorized, provides PricingService,
// DraftingService and ReviseService, and serves drafting, revise, preview, reference and PDF download routes. Imports
// DocumentsModule, SettingsModule (MoneyService, NumberingService, SettingsService), ApprovalsModule (preview
// route, approval cancel on revise), AuditModule, OpportunitiesModule (Won on acceptance) and NotifyModule (the
// owner's notice); the database is global. Q3b adds the outcome route and exports its accept/reject core.
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
import { QuotationDocumentController } from './document/quotation-document.controller';
import {
  QuotationDocumentService,
  QuotationDocumentStore,
} from './document/quotation-document.service';
import { DraftingCaller } from './drafting/drafting.caller';
import { DraftingController } from './drafting/drafting.controller';
import { DraftingService } from './drafting/drafting.service';
import { CancelController } from './drafting/cancel.controller';
import { CancelService } from './drafting/cancel.service';
import { ReviseController } from './drafting/revise.controller';
import { ReviseService } from './drafting/revise.service';
import { PricingService } from './pricing/pricing.service';
import { QuotationPreviewCaller } from './preview/quotation-preview.caller';
import { QuotationPreviewController } from './preview/quotation-preview.controller';
import { QuotationPreviewService } from './preview/quotation-preview.service';
import { QuotationOutcomeService } from './outcome/quotation-outcome.service';
import { RecordOutcomeController } from './outcome/record-outcome.controller';
import { RecordOutcomeService } from './outcome/record-outcome.service';
import { drizzleHeadLoader, QuotationOwnerPolicy } from './quotation-owner.policy';
import { MasterDataCaller } from './reference/master-data.caller';
import { MasterDataController } from './reference/master-data.controller';
import { MasterDataService } from './reference/master-data.service';
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
    MasterDataController,
    QuotationPreviewController,
    ReviseController,
    CancelController,
    QuotationSubmitController,
    RecordOutcomeController,
    QuotationSendController,
    QuotationDocumentController,
  ],
  providers: [
    PricingService,
    DraftingService,
    DraftingCaller,
    ReferenceCaller,
    ReferenceService,
    MasterDataCaller,
    MasterDataService,
    QuotationPreviewService,
    QuotationPreviewCaller,
    ReviseService,
    CancelService,
    QuotationSubmitService,
    QuotationSubmitStore,
    QuotationSubmitCaller,
    QuotationOutcomeService,
    RecordOutcomeService,
    QuotationSendService,
    QuotationSendStore,
    QuotationSendCaller,
    QuotationDocumentService,
    QuotationDocumentStore,
  ],
  // QuotationOutcomeService is the accept/reject core the portal (unit PA) calls inside its own transaction.
  exports: [PricingService, QuotationOutcomeService],
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
