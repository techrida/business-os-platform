// Quotations module (P2 unit Q1, skeleton): it registers how the files of a quotation version are authorized,
// with the documents module, provides PricingService and serves the reference lists (tax codes, payment terms).
// The drafting controller, the drafting service and the render job
// join it in later parts. Imports DocumentsModule for DocumentsService and SettingsModule for MoneyService
// (PricingService's FX snapshot) and ApprovalsModule for ApprovalsService (the preview's route); the database is global. Only AppModule imports this module.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { PricingService } from './pricing/pricing.service';
import { QuotationPreviewCaller } from './preview/quotation-preview.caller';
import { QuotationPreviewController } from './preview/quotation-preview.controller';
import { QuotationPreviewService } from './preview/quotation-preview.service';
import { drizzleHeadLoader, QuotationOwnerPolicy } from './quotation-owner.policy';
import { ReferenceCaller } from './reference/reference.caller';
import { ReferenceController } from './reference/reference.controller';
import { ReferenceService } from './reference/reference.service';

@Module({
  imports: [ApprovalsModule, DocumentsModule, SettingsModule],
  controllers: [ReferenceController, QuotationPreviewController],
  providers: [
    PricingService,
    ReferenceCaller,
    ReferenceService,
    QuotationPreviewService,
    QuotationPreviewCaller,
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
