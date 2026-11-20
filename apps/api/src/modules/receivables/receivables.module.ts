// Receivables module (P3 U8): allocations of verified payments to issued invoices and debit notes, their reversal,
// and the receivables reads (statement, aging, customer advance), and promises to pay (F1-Q33; the job that marks a
// missed one lives in PaymentPromiseWorkerModule). Serves POST /v1/payments/:id/allocations[...] and
// /v1/receivables/*. Imports AuditModule and LedgerModule; the database and AuthzModule are global. Exports both
// services (U12's credit notes and U13's portal reads may call them).
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AllocationsService } from './allocations.service';
import {
  PaymentAllocationsController,
  ReceivablesCaller,
  ReceivablesController,
} from './receivables.controller';
import { ReceivablesService } from './receivables.service';
import { PaymentPromisesController } from './promises/payment-promises.controller';
import { PaymentPromisesService } from './promises/payment-promises.service';

@Module({
  imports: [AuditModule, LedgerModule],
  controllers: [PaymentAllocationsController, ReceivablesController, PaymentPromisesController],
  providers: [AllocationsService, ReceivablesService, ReceivablesCaller, PaymentPromisesService],
  exports: [AllocationsService, ReceivablesService],
})
export class ReceivablesModule {}
