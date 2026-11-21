// Invoices module (P3 unit U10): registers how invoice files are authorized (only the render job adds the PDF of an
// issued invoice), provides InvoiceDraftingService and InvoiceIssueService and serves `v1/invoices`. Imports
// DocumentsModule (the owner registry), SettingsModule (MoneyService, NumberingService, SettingsService), AuditModule
// LedgerModule (lockForMoneyCommand) and ApprovalsModule (U6: submit, and the approval subjects registered here); the
// database is global. U12 part B adds credit- and debit-note drafting (NotesController on `v1`); part C adds
// CreditNoteIssueService, which InvoiceIssueService calls for a credit note. Round 5 (S3) adds InvoiceRenderNudgeModule:
// the issue enqueues the PDF render once it commits.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ApprovalsService } from '../approvals/requests.service';
import { LedgerModule } from '../ledger/ledger.module';
import {
  INVOICE_APPROVAL_DOCUMENT_TYPES,
  InvoiceApprovalService,
  InvoiceApprovalSubject,
} from './invoice-approval.service';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';
import { InvoiceVatRegisterService } from './invoice-vat-register.service';
import { drizzleInvoiceHeadLoader, InvoiceOwnerPolicy } from './invoice-owner.policy';
import { InvoiceCaller } from './invoice-support';
import { InvoicesController } from './invoices.controller';
import { CreditNoteIssueService } from './notes/credit-note-issue.service';
import { NoteDraftingService } from './notes/note-drafting.service';
import { NotesController } from './notes/notes.controller';
import { InvoiceRenderNudgeModule } from './render/invoice-render.nudge';

@Module({
  imports: [
    ApprovalsModule,
    AuditModule,
    DocumentsModule,
    InvoiceRenderNudgeModule,
    LedgerModule,
    SettingsModule,
  ],
  controllers: [InvoicesController, NotesController],
  providers: [
    InvoiceCaller,
    InvoiceDraftingService,
    InvoiceIssueService,
    InvoiceApprovalService,
    InvoiceVatRegisterService,
    NoteDraftingService,
    CreditNoteIssueService,
  ],
  exports: [InvoiceDraftingService, InvoiceIssueService, InvoiceApprovalService],
})
export class InvoicesModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(this.db)));
    // One approval subject per document type (tax_invoice, credit_note, debit_note), API only like quotations.
    for (const type of INVOICE_APPROVAL_DOCUMENT_TYPES) {
      this.approvals.registerSubject(new InvoiceApprovalSubject(type));
    }
  }
}
