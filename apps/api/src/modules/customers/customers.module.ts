// Customers module (owner: C1): the tenant-level customer records, their contacts and their per-entity terms.
// It imports SettingsModule for NumberingService (the customer number) and AuditModule for the duplicate
// override's domain event (F1-Q55). AuthzModule and the database are global,
// so they are not listed. Only AppModule imports this module: the worker serves no customer routes.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { VerificationModule } from '../verification/verification.module';
import { CustomersCaller } from './customers.caller';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [SettingsModule, AuditModule, VerificationModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersCaller],
  // Exported for lead conversion (C2a), which creates a customer and its contact inside its own transaction.
  exports: [CustomersService],
})
export class CustomersModule {}
