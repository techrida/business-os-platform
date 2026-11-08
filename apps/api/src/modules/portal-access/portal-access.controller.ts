// HTTP route of portal access (K8). Thin on purpose: the header and body checks here, every rule in
// PortalAccessService. @Can names the route permission (deny by default); the service adds staff-only and the
// record-level check.
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { PortalAccessService } from './portal-access.service';
import { GrantPortalAccessBodySchema, type PortalAccessDto } from './portal-access.types';

@Controller('v1/customers')
export class PortalAccessController {
  constructor(private readonly portalAccess: PortalAccessService) {}

  /**
   * 201 with the portal admin (status invited). 400 without an Idempotency-Key, with a bad body or for a
   * contact without an email; 404 for a customer or contact outside the caller's scope; 409 `kyb_not_verified`
   * unless the customer's KYB case is approved. A replay with the same key answers the stored body.
   */
  @Post(':id/portal-access')
  @Can('customer.write')
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalAccessDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.portalAccess.grant(
      id,
      parseOr400(GrantPortalAccessBodySchema, body),
      key,
    );
    res.status(result.status);
    return result.response;
  }
}
