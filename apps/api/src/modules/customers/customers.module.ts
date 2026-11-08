// Customers module (owner: C1): the tenant-level customer records, their contacts and their per-entity terms.
// It imports SettingsModule for NumberingService (the customer number). AuthzModule and the database are global,
// so they are not listed. Only AppModule imports this module: the worker serves no customer routes.
import { Module } from '@nestjs/common';

import { SettingsModule } from '../../platform/settings/settings.module';
import { CustomersCaller } from './customers.caller';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [SettingsModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersCaller],
})
export class CustomersModule {}
