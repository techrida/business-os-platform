// Quotations module (P2 unit Q1): registers how quotation-version files are authorized, provides PricingService,
// DraftingService and ReviseService, and serves drafting, revise, preview and reference routes. Imports
// DocumentsModule, SettingsModule (MoneyService, NumberingService, SettingsService), ApprovalsModule (preview
// route, approval cancel on revise) and AuditModule; the database is global.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { AuditModule } from '../../platform/audit/audit.module';
import { ApprovalsModule } from '../approvals/approvals.module';
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

@Module({
  imports: [ApprovalsModule, AuditModule, DocumentsModule, SettingsModule],
  controllers: [
    DraftingController,
    ReferenceController,
    QuotationPreviewController,
    ReviseController,
    QuotationSubmitController,
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
  ],
  exports: [PricingService],
})
export class QuotationsModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** registerOwner throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new QuotationOwnerPolicy(drizzleHeadLoader(this.db)));
  }
}
