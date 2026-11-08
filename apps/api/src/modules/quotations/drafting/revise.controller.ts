// HTTP route of the quotation revise (P2 unit Q1b-C). Thin on purpose: parsing here, every rule in ReviseService.
// @Can names the permission at route level (does the role hold quotation.revise at all); the service then checks
// the quotation itself (entity, own scope). POST needs an Idempotency-Key, so a retry cannot create two revisions.
import { ReviseQuotationBodySchema, type QuotationVersionDto } from '@bos/contracts';
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { ReviseService } from './revise.service';

@Controller('v1/quotations')
export class ReviseController {
  constructor(private readonly revisions: ReviseService) {}

  /**
   * 201 with the new Draft QuotationVersionDto. 400 without an Idempotency-Key or with a bad body; 404 for a
   * quotation of another entity or outside the caller's scope; 409 for a stale expectedVersion or a current
   * version that cannot be revised.
   */
  @Post(':id/revise')
  @Can('quotation.revise')
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationVersionDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.revisions.revise(id, parseOr400(ReviseQuotationBodySchema, body), key);
  }
}
