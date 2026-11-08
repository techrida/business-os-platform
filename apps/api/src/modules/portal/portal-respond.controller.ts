// HTTP routes of the customer's accept and reject in the portal (P2 unit PA-3). Thin on purpose: every rule,
// including the Idempotency-Key and the body parsing, is in PortalRespondService, so a staff caller is refused
// before either is looked at. Each route needs `portal.quotation.respond` (route level). The `:id` is a quotation
// version id, the `id` of CustomerQuotationView, as for the reads.
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { PortalRespondService, type PortalDecision } from './portal-respond.service';

@Controller('v1/portal/quotations')
export class PortalRespondController {
  constructor(private readonly respond: PortalRespondService) {}

  /**
   * 201 with `{id, status: 'accepted', decidedOn}`. 400 without an Idempotency-Key or with a bad body; 403 for a
   * caller that is not a customer with a party; 404 for a foreign, hidden or unknown id; 409 when the version was
   * already answered, revised or expired; 422 when the entity's evidence policy wants more than a signed quote.
   */
  @Post(':id/accept')
  @Can('portal.quotation.respond')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PortalDecision> {
    return this.respond.accept(id, idempotencyKey, body);
  }

  /** 201 with `{id, status: 'rejected', decidedOn}`. A comment is required (400 without one). */
  @Post(':id/reject')
  @Can('portal.quotation.respond')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PortalDecision> {
    return this.respond.reject(id, idempotencyKey, body);
  }
}
