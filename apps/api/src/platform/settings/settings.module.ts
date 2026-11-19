// Settings kernel: versioned settings, gap-free numbering and NPR money conversion.
//
// Two modules on purpose. SettingsModule holds the services only, so the worker can import it without
// registering HTTP routes. SettingsHttpModule adds the admin and document-settings controllers, and only AppModule imports it.
import { Module } from '@nestjs/common';

import { DocumentLogoModule } from '../../modules/images/document-logo.resolver';
import { CurrencyEnabledService } from './currency-enabled';
import { DocumentSettingsController } from './document-settings/document-settings.controller';
import { DocumentSettingsService } from './document-settings/document-settings.service';
import { MoneyService } from './money.service';
import { NumberingService } from './numbering.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  providers: [SettingsService, NumberingService, MoneyService, CurrencyEnabledService],
  exports: [SettingsService, NumberingService, MoneyService, CurrencyEnabledService],
})
export class SettingsModule {}

// DocumentLogoModule: the document-style preview draws the uploaded logo (DocumentSettingsService.previewDocument).
@Module({
  imports: [SettingsModule, DocumentLogoModule],
  controllers: [SettingsController, DocumentSettingsController],
  providers: [DocumentSettingsService],
})
export class SettingsHttpModule {}
