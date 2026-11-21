// Customer and vendor CSV import (round 5, K1). Imports CustomersModule and VendorsModule for the services that create
// one record inside the batch's transaction, and AuditModule for the commit event; AuthzModule and the database are
// global. Only AppModule imports this module: the worker serves no import routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { PartyImportsCaller } from './party-imports.caller';
import { PartyImportsController } from './party-imports.controller';
import { PartyImportsService } from './party-imports.service';

@Module({
  imports: [AuditModule, CustomersModule, VendorsModule],
  controllers: [PartyImportsController],
  providers: [PartyImportsService, PartyImportsCaller],
})
export class PartyImportsModule {}
