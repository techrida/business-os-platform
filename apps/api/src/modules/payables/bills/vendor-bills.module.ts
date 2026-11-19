// Vendor bills module (P4 units A1 and A1b): the REST routes of bills (enter, match, exceptions, submit) and the
// registration of the vendor_bill and match_exception approval subjects. The vendor_bill subject posts an approved
// bill through LedgerService (the payable open item and vendor_bill_posted), so LedgerModule is imported. onDecided
// runs only from ApprovalsService.act (an API route), so the worker never needs the subjects.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { DocumentsModule } from '../../../platform/documents/documents.module';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerModule } from '../../ledger/ledger.module';
import { LedgerService } from '../../ledger/ledger.service';
import { BillDocumentsController } from './bill-documents.controller';
import { BillDocumentsService, billDocumentOwnerPolicy } from './bill-documents.service';
import { MatchExceptionSubject, VendorBillSubject } from './vendor-bill.subject';
import { VendorBillsCaller } from './vendor-bills.caller';
import { VendorBillsController } from './vendor-bills.controller';
import { VendorBillsService } from './vendor-bills.service';
import { VendorOrdersController } from './vendor-orders.controller';
import { VendorOrdersService } from './vendor-orders.service';

@Module({
  imports: [ApprovalsModule, AuditModule, DocumentsModule, LedgerModule, SettingsModule],
  controllers: [VendorBillsController, BillDocumentsController, VendorOrdersController],
  providers: [VendorBillsService, VendorBillsCaller, BillDocumentsService, VendorOrdersService],
  exports: [VendorBillsService],
})
export class VendorBillsModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(billDocumentOwnerPolicy(this.db));
    this.approvals.registerSubject(
      new VendorBillSubject(this.audit, () => new Date(), this.ledger),
    );
    this.approvals.registerSubject(new MatchExceptionSubject(this.audit));
  }
}
