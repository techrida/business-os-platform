// `GET /v1/branding`: the company's display name and current logo for the workspace and portal headers (R6Q20). Any
// signed-in principal may read it (a customer or vendor sees the same name and logo the emails already show), so the
// route is @AnyAuthenticated; it answers only what `brandingFromProfile` lets out of the profile.
import type { Branding } from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { requestTx } from '../../platform/db/tx';
import { readBranding } from '../../platform/settings/company-branding';
import { SettingsService } from '../../platform/settings/settings.service';

@Controller('v1/branding')
export class BrandingController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @AnyAuthenticated()
  get(): Promise<Branding> {
    return readBranding(this.settings, requestTx().scope);
  }
}
