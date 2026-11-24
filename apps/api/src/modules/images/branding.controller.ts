// `GET /v1/branding`: the company's display name and current logo for the workspace and portal headers (R6Q20). Any
// signed-in principal may read it (a customer or vendor sees the same name and logo the emails already show), so the
// route is @AnyAuthenticated; it answers only what `brandingFromProfile` lets out of the profile.
import type { Branding } from '@bos/contracts';
import { Controller, Get, Inject } from '@nestjs/common';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { DB, type Db } from '../../platform/db/db.module';
import { requestTx } from '../../platform/db/tx';
import { readBranding } from '../../platform/settings/company-branding';

@Controller('v1/branding')
export class BrandingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @AnyAuthenticated()
  get(): Promise<Branding> {
    return readBranding(this.db, requestTx().scope);
  }
}
