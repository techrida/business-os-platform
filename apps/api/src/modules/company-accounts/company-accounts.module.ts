// Company bank accounts and expense accounts (round 5, unit P1): the Settings > Finance routes and the lookup the
// payables services check their account ids with. The database and authz are global; AuditModule gives AuditService.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { CompanyAccountsCaller } from './company-accounts.caller';
import {
  CompanyBankAccountsController,
  ExpenseAccountsController,
} from './company-accounts.controller';
import { CompanyAccountsLookup } from './company-accounts.lookup';
import { CompanyAccountsService } from './company-accounts.service';

@Module({
  imports: [AuditModule],
  controllers: [CompanyBankAccountsController, ExpenseAccountsController],
  providers: [CompanyAccountsService, CompanyAccountsCaller, CompanyAccountsLookup],
  exports: [CompanyAccountsLookup],
})
export class CompanyAccountsModule {}
