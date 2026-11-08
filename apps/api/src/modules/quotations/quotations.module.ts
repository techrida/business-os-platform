// Quotations module (P2 unit Q1, skeleton): it registers how the files of a quotation version are authorized,
// with the documents module, and provides PricingService. Controllers, the drafting service and the render job
// join it in later parts. Imports DocumentsModule for DocumentsService and SettingsModule for MoneyService
// (PricingService's FX snapshot); the database is global. Only AppModule imports this module.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { PricingService } from './pricing/pricing.service';
import { drizzleHeadLoader, QuotationOwnerPolicy } from './quotation-owner.policy';

@Module({
  imports: [DocumentsModule, SettingsModule],
  providers: [PricingService],
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
