// Sales orders module (P3 unit U9): confirm an accepted quotation version as a sales order, list and read orders,
// and mark a schedule line billable. Imports SettingsModule (SettingsService, NumberingService), AuditModule and
// LedgerModule (lock helper and open amounts for `deliveryReleased`); the database is global. Exports the service
// so P4's delivery module and the invoicing units can call it. Only AppModule imports this module.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SalesOrdersCaller } from './sales-orders.caller';
import { SalesOrdersController } from './sales-orders.controller';
import { SalesOrdersService } from './sales-orders.service';

@Module({
  imports: [AuditModule, LedgerModule, SettingsModule],
  controllers: [SalesOrdersController],
  providers: [SalesOrdersService, SalesOrdersCaller],
  exports: [SalesOrdersService],
})
export class SalesOrdersModule {}
