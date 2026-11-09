// Ledger module (owner: P3 U0-B): exports LedgerService, the single writer of the AR/AP subledger. The database is
// global, so nothing is imported. Invoices, payments, credit notes and (P4) vendor bills import this module; the
// worker module imports it too once a posting worker calls it.
import { Module } from '@nestjs/common';

import { LedgerService } from './ledger.service';

@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
