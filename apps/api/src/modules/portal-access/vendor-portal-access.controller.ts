// HTTP route of the vendor portal grant (K4). Thin on purpose: the header and body checks here, every rule in
// VendorPortalAccessService. @Can names the route permission (deny by default); the service adds staff-only and the
// record-level check.
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { VendorPortalAccessService } from './portal-access.service';
import {
  GrantVendorPortalAccessBodySchema,
  type VendorPortalAccessDto,
} from './portal-access.types';

@Controller('v1/vendors')
export class VendorPortalAccessController {
  constructor(private readonly portalAccess: VendorPortalAccessService) {}

  /**
   * 201 with the portal admin and its capability. 400 without an Idempotency-Key, with a bad body or for a
   * contact without an email; 404 for a vendor or contact outside the caller's scope; 409 `invalid_transition`
   * unless the vendor is approved or pending_kyc. A replay with the same key answers the stored body.
   */
  @Post(':id/portal-access')
  @Can('vendor.write')
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VendorPortalAccessDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.portalAccess.grant(
      id,
      parseOr400(GrantVendorPortalAccessBodySchema, body),
      key,
    );
    res.status(result.status);
    return result.response;
  }
}
