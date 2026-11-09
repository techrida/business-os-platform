// Invoices module (P3 unit U10): registers how invoice files are authorized (only the render job adds the PDF of an
// issued invoice), provides InvoiceDraftingService and InvoiceIssueService and serves `v1/invoices`. Imports
// DocumentsModule (the owner registry), SettingsModule (MoneyService, NumberingService, SettingsService), AuditModule
// and LedgerModule (lockForMoneyCommand); the database is global. U6 adds submit and the approval subject, U12 the notes.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { LedgerModule } from '../ledger/ledger.module';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';
import { drizzleInvoiceHeadLoader, InvoiceOwnerPolicy } from './invoice-owner.policy';
import { InvoiceCaller } from './invoice-support';
import { InvoicesController } from './invoices.controller';

@Module({
  imports: [AuditModule, DocumentsModule, LedgerModule, SettingsModule],
  controllers: [InvoicesController],
  providers: [InvoiceCaller, InvoiceDraftingService, InvoiceIssueService],
  exports: [InvoiceDraftingService, InvoiceIssueService],
})
export class InvoicesModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(this.db)));
  }
}
