// Settings kernel: versioned settings, gap-free numbering and NPR money conversion.
//
// Two modules on purpose. SettingsModule holds the services only, so the worker can import it without
// registering HTTP routes. SettingsHttpModule adds the admin controller, and only AppModule imports it.
import { Module } from '@nestjs/common';

import { MoneyService } from './money.service';
import { NumberingService } from './numbering.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  providers: [SettingsService, NumberingService, MoneyService],
  exports: [SettingsService, NumberingService, MoneyService],
})
export class SettingsModule {}

@Module({
  imports: [SettingsModule],
  controllers: [SettingsController],
})
export class SettingsHttpModule {}
